import { readdirSync } from "node:fs";
import { createServerSupabase } from "./supabase";

/**
 * Warns when the database schema is behind the migrations shipped with this
 * build. Nothing migrates on boot — that is deliberate, because several
 * replicas can start at once against one database — so the failure mode
 * without this check is a feature dying on a missing column and surfacing as
 * an unrelated application error.
 *
 * Reports only; it never migrates and never stops the server.
 */
export async function checkSchemaVersion(args?: {
  db?: ReturnType<typeof createServerSupabase>;
  migrationsDir?: string;
  log?: (message: string) => void;
}): Promise<{ pending: string[]; checked: boolean }> {
  const log = args?.log ?? console.warn;
  let onDisk: string[];
  try {
    onDisk = readdirSync(args?.migrationsDir ?? "migrations")
      .filter((name) => name.toLowerCase().endsWith(".sql"))
      .map((name) => name.replace(/\.sql$/i, ""))
      .sort();
  } catch {
    // No migrations directory in this layout — nothing to compare against.
    return { pending: [], checked: false };
  }
  if (!onDisk.length) return { pending: [], checked: false };

  const db = args?.db ?? createServerSupabase();
  const applied = await db.from("pgmigrations").select("name");
  if (applied.error) {
    // The table is not readable in every deployment shape. A schema check is
    // a convenience: it must never be the reason a server fails to boot.
    log(
      `[schema] could not read applied migrations (${applied.error.message}); skipping check`,
    );
    return { pending: [], checked: false };
  }

  const appliedNames = new Set(
    ((applied.data ?? []) as Array<{ name?: unknown }>).map((row) =>
      String(row.name ?? ""),
    ),
  );
  const pending = onDisk.filter((name) => !appliedNames.has(name));
  if (pending.length) {
    log(
      [
        "",
        "  ============================================================",
        `  SCHEMA IS BEHIND THIS BUILD — ${pending.length} migration(s) not applied:`,
        ...pending.map((name) => `    - ${name}`),
        "",
        "  Features using these tables or columns will fail in ways that",
        "  look unrelated. Apply them with:",
        "    npm run migrate:local --prefix backend   (docker stack)",
        "    npm run migrate:dev   --prefix backend   (other databases)",
        "  ============================================================",
        "",
      ].join("\n"),
    );
  }
  return { pending, checked: true };
}
