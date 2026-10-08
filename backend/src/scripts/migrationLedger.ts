import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { runner } from "node-pg-migrate";
import type { ClientBase } from "pg";

// Upstream 49efc046: keep Dev's numbered pgmigrations history authoritative.
// This is node-pg-migrate 7.x's lock, shared with its CLI and older jobs.
const MIGRATION_LOCK_ID = "7241865325823964";
const FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/i;

export type MigrationCommand =
  | { kind: "status" | "up" }
  | { kind: "baseline" | "mark"; filename: string };

export function parseMigrationCommand(args: string[]): MigrationCommand {
  const [kind = "up", filename, confirmation, ...extra] = args;
  if ((kind === "up" || kind === "status") && args.length <= 1) return { kind };
  if ((kind === "baseline" || kind === "mark") && filename &&
      FILE_PATTERN.test(filename) && confirmation === "--confirm-applied" && !extra.length) {
    return { kind, filename };
  }
  throw new Error("Usage: migrate [up|status|baseline FILE --confirm-applied|mark FILE --confirm-applied]");
}

export type MigrationFile = { filename: string; name: string; checksum: string };
export type AppliedMigration = { name: string; checksum: string | null };

export async function migrationFiles(directory: string): Promise<MigrationFile[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const slots = new Set<string>();
  return Promise.all(names.map(async (filename) => {
    const slot = filename.slice(0, 4);
    if (!FILE_PATTERN.test(filename) || slots.has(slot)) {
      throw new Error(`Invalid or duplicate numbered migration: ${filename}`);
    }
    slots.add(slot);
    // Git checkouts on Windows can use CRLF. Hash the same UTF-8 SQL on every
    // host; whitespace/content changes beyond line-ending conversion still count.
    const sql = (await readFile(path.join(directory, filename), "utf8")).replace(/\r\n/g, "\n");
    return {
      filename, name: filename.slice(0, -4),
      checksum: createHash("sha256").update(sql).digest("hex"),
    };
  }));
}

export function compareMigrationHistory(files: MigrationFile[], applied: AppliedMigration[]) {
  const byName = new Map(files.map((file) => [file.name, file]));
  const recorded = new Set(applied.map((row) => row.name));
  const pending = files.filter((file) => !recorded.has(file.name));
  return {
    pending,
    changed: applied.filter((row) => row.checksum && byName.has(row.name) &&
      row.checksum !== byName.get(row.name)!.checksum).map((row) => row.name),
    missing: applied.filter((row) => !byName.has(row.name)).map((row) => row.name),
    unverified: applied.filter((row) => !row.checksum).map((row) => row.name),
    outOfOrder: pending.filter((file) => applied.some((row) => row.name > file.name)).map((file) => file.name),
  };
}

async function readHistory(client: ClientBase): Promise<AppliedMigration[]> {
  const existence = await client.query<{ present: boolean }>(
    "select to_regclass('public.pgmigrations') is not null as present",
  );
  if (!existence.rows[0]?.present) return [];
  const columns = await client.query<{ present: boolean }>(
    "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'pgmigrations' and column_name = 'checksum') as present",
  );
  const checksum = columns.rows[0]?.present ? "checksum" : "null::text as checksum";
  return (await client.query<AppliedMigration>(
    `select name, ${checksum} from public.pgmigrations order by run_on, id`,
  )).rows;
}

/** The caller owns a connected direct PostgreSQL session, never a transaction pooler. */
export async function runMigrationCommand(
  client: ClientBase,
  command: MigrationCommand,
  directory = "migrations",
  log: Pick<Console, "info" | "warn" | "error"> = console,
): Promise<number> {
  const locked = await client.query<{ acquired: boolean }>(
    "select pg_try_advisory_lock($1::bigint) as acquired", [MIGRATION_LOCK_ID],
  );
  if (!locked.rows[0]?.acquired) throw new Error("Another migration is already running");
  try {
    const files = await migrationFiles(directory);
    const history = await readHistory(client);
    const state = compareMigrationHistory(files, history);
    for (const name of state.changed) log.warn(`[migrate] changed since applied: ${name}`);
    for (const name of state.missing) log.warn(`[migrate] recorded file is missing or renamed: ${name}`);
    for (const name of state.outOfOrder) log.warn(`[migrate] pending file precedes applied history: ${name}`);
    if (state.unverified.length) log.warn(
      `[migrate] ${state.unverified.length} recorded migration(s) have no verified checksum (older runner or explicitly recorded without execution)`,
    );
    if (command.kind === "status") {
      log.info(`${history.length} recorded, ${state.pending.length} pending, ${state.unverified.length} unverified`);
      for (const file of state.pending) log.info(`  pending: ${file.filename}`);
      if (state.changed.length || state.missing.length || state.outOfOrder.length) return 1;
      return state.pending.length ? 2 : 0;
    }
    // Do not let an upgrade silently replay a renamed file or accept changed
    // history. Restore shipped files and use a forward migration to correct SQL.
    if (state.changed.length || state.missing.length || state.outOfOrder.length) {
      throw new Error("Migration history differs from this checkout; inspect status before upgrading");
    }
    let selected = state.pending;
    if (command.kind === "baseline" || command.kind === "mark") {
      const target = files.find((file) => file.filename === command.filename);
      if (!target) throw new Error(`No migration named ${command.filename}`);
      if (command.kind === "mark" && state.pending[0]?.name !== target.name) {
        throw new Error("mark must name the next pending migration, preserving numbered history");
      }
      selected = command.kind === "mark" ? [target] : state.pending.filter((file) => file.name <= target.name);
    }
    if (!selected.length) { log.info("Up to date."); return 0; }

    const executed = await runner({
      dbClient: client,
      dir: directory,
      migrationsSchema: "public",
      migrationsTable: "pgmigrations",
      direction: "up",
      count: selected.length,
      checkOrder: true,
      singleTransaction: true,
      // The same session already owns the library's advisory lock, across
      // integrity checks, migration execution and checksum recording.
      noLock: true,
      fake: command.kind !== "up",
      ignorePattern: "(?![0-9]{4}_[a-zA-Z0-9_]+\\.sql$).*",
      logger: log,
    });
    if (command.kind !== "up") {
      log.warn(`[migrate] explicitly recorded ${executed.length} migration(s) WITHOUT running SQL; checksums remain unverified`);
      return 0;
    }

    // A crash after the library commits but before this transaction leaves
    // NULL checksums, which status reports as unverified. It never makes an
    // applied file pending or silently certifies any older historical row.
    const current = new Map((await migrationFiles(directory)).map((file) => [file.name, file]));
    const original = new Map(files.map((file) => [file.name, file]));
    for (const migration of executed) {
      if (current.get(migration.name)?.checksum !== original.get(migration.name)?.checksum) {
        throw new Error("Migration files changed while upgrading; applied history remains recorded but checksums are unverified");
      }
    }
    await client.query("begin");
    try {
      // 0109 introduces the column. A fixture/older checkout without it can
      // still use the runner, retaining its existing recorded-only history.
      const column = await client.query<{ present: boolean }>(
        "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'pgmigrations' and column_name = 'checksum') as present",
      );
      if (column.rows[0]?.present) {
        for (const migration of executed) await client.query(
          "update public.pgmigrations set checksum = $1 where name = $2 and checksum is null",
          [original.get(migration.name)!.checksum, migration.name],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
    return 0;
  } finally {
    await client.query("select pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_ID]);
  }
}
