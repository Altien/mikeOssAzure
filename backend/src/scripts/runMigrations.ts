import { DefaultAzureCredential } from "@azure/identity";
import { spawn } from "node:child_process";
import { Client } from "pg";

const AAD_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";

function getAuthProvider() {
  return (process.env.AUTH_PROVIDER ?? "supabase").toLowerCase();
}

function runNodePgMigrate(databaseUrl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    // node-pg-migrate ships as an npm bin. On Windows the resolver is
    // `npx.cmd`; spawn() doesn't auto-suffix `.cmd` on win32, AND Node
    // 18+ blocks spawning `.cmd` directly without `shell: true` (CVE
    // mitigation). So on Windows we both pick the right binary name
    // and route through a shell.
    const isWin = process.platform === "win32";
    const child = spawn(
      isWin ? "npx.cmd" : "npx",
      [
        "node-pg-migrate",
        "up",
        "--migrations-dir",
        "migrations",
        "--migration-file-language",
        "sql",
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
        },
        stdio: "inherit",
        shell: isWin,
      },
    );

    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

// Tell PostgREST to rebuild its schema cache from pg_catalog.
//
// PostgREST builds its REST surface (which tables/columns are exposed,
// which return types) at startup and on receipt of a `pgrst, 'reload
// schema'` NOTIFY.  Without this step the first request to a freshly-
// added column will 500 with `Could not find the 'X' column of 'Y' in
// the schema cache`.  We do this from the migration job rather than by
// restarting PostgREST because (a) it doesn't drop in-flight requests
// and (b) the migration job already has DB credentials handy.
//
// The NOTIFY is best-effort: if PostgREST isn't listening yet (or isn't
// running) the message is dropped, but the migration itself has already
// committed.  We log the failure and move on rather than retrying — a
// transient failure here is recoverable by restarting PostgREST.
async function reloadPostgrestSchemaCache(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("NOTIFY pgrst, 'reload schema'");
    console.log("[migrate] PostgREST schema cache reload notified");
  } catch (err) {
    console.error(
      "[migrate] failed to NOTIFY PostgREST — schema cache may be stale until PostgREST restarts",
      err,
    );
  } finally {
    await client.end().catch(() => {});
  }
}

async function getDatabaseUrl(): Promise<string> {
  const provider = getAuthProvider();

  if (provider !== "entra") {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required when AUTH_PROVIDER is not 'entra'");
    }
    return databaseUrl;
  }

  const pgHost = process.env.PG_HOST;
  const pgDatabase = process.env.PG_DATABASE ?? "postgres";
  const pgMiUsername = process.env.PG_MI_USERNAME;
  const pgPort = process.env.PG_PORT ?? "5432";

  if (!pgHost || !pgMiUsername) {
    throw new Error(
      "PG_HOST and PG_MI_USERNAME are required when AUTH_PROVIDER=entra for migration job",
    );
  }

  const credential = new DefaultAzureCredential();
  const token = await credential.getToken(AAD_SCOPE);

  if (!token?.token) {
    throw new Error("Failed to acquire Managed Identity token for PostgreSQL");
  }

  return `postgresql://${encodeURIComponent(pgMiUsername)}:${encodeURIComponent(token.token)}@${pgHost}:${pgPort}/${pgDatabase}?sslmode=require`;
}

async function main() {
  const databaseUrl = await getDatabaseUrl();
  const exitCode = await runNodePgMigrate(databaseUrl);

  if (exitCode !== 0) {
    throw new Error(`node-pg-migrate exited with code ${exitCode}`);
  }

  await reloadPostgrestSchemaCache(databaseUrl);
}

main().catch((error) => {
  console.error("Migration job failed", error);
  process.exit(1);
});
