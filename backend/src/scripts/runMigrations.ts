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
        // The migrations dir also carries UPSTREAM_SYNC_LOG.md (sync provenance,
        // written by the migration tooling). Without this, node-pg-migrate tries
        // to load the .md as a migration module and crashes ("Invalid or
        // unexpected token"), failing the whole migration job. Ignore non-SQL
        // docs. Caught by the local-stack test before OSS promotion.
        "--ignore-pattern",
        ".*\\.md",
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

// Azure Postgres Flexible Server rejects non-TLS connections from outside
// the server's own subnet with `no pg_hba.conf entry for host ..., no
// encryption`. The entra-mode path below builds its own URL with
// `?sslmode=require`; the env-var path inherits whatever the operator set in
// KV. Default-add it because real installs may omit sslmode.
function ensureSslMode(url: string): string {
  if (/[?&]sslmode=/i.test(url)) return url;
  return url + (url.includes("?") ? "&" : "?") + "sslmode=require";
}

async function getDatabaseUrl(): Promise<string> {
  // Migrate-job DB connection strategy is independent of AUTH_PROVIDER
  // (which is the app sign-in mode, consumed by routes/auth.ts).
  // Conflating them blocks installs that legitimately want
  // Entra sign-in for users + password auth from the migrate job — see
  // Keep migration authentication independent from request authentication.
  //
  // Preference order:
  //   1. DATABASE_URL — works with a KV-backed pgrst-db-uri,
  //      supabase, local, and any entra-with-password setup.
  //   2. MI-token path — for Entra-Postgres installs where the flex
  //      server has activeDirectoryAuth=Enabled and the UAMI is
  //      registered as a Postgres role.
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    return ensureSslMode(databaseUrl);
  }

  const pgHost = process.env.PG_HOST;
  const pgMiUsername = process.env.PG_MI_USERNAME;
  if (pgHost && pgMiUsername) {
    const pgDatabase = process.env.PG_DATABASE ?? "postgres";
    const pgPort = process.env.PG_PORT ?? "5432";

    const credential = new DefaultAzureCredential();
    const token = await credential.getToken(AAD_SCOPE);

    if (!token?.token) {
      throw new Error("Failed to acquire Managed Identity token for PostgreSQL");
    }

    return `postgresql://${encodeURIComponent(pgMiUsername)}:${encodeURIComponent(token.token)}@${pgHost}:${pgPort}/${pgDatabase}?sslmode=require`;
  }

  throw new Error(
    "Migrate job needs either DATABASE_URL, or PG_HOST + PG_MI_USERNAME for MI-token auth",
  );
}

// Creates / refreshes the `authenticator` Postgres role that PostgREST
// connects as. The role has only LOGIN +
// NOINHERIT plus membership in web_anon / authenticated / service_role
// — minimum privileges to SET ROLE at PostgREST's connection boundary,
// nothing else. Replaces the previous pattern where PostgREST connected
// as `mikeadmin` (full superuser).
//
// Runs after node-pg-migrate (which created the role tier in
// 0005_postgres_roles.sql) and is fully idempotent: creates the role if
// missing, syncs the password every run, re-grants memberships.
//
// Password comes from PGRST_AUTHENTICATOR_PASSWORD env var, sourced
// from a Bicep-generated KV secret (newGuid() per deploy). DDL can't
// be parameterized so we interpolate into the SQL — Bicep's newGuid()
// format is alphanumeric+hyphen only, which we validate defensively
// before interpolation. Throws on a non-conforming value rather than
// risking SQL injection.
//
// Skipped (no-op) when the env var is unset so legacy installs continue
// working until they configure the dedicated role.
async function ensureAuthenticatorRole(databaseUrl: string): Promise<void> {
  const password = process.env.PGRST_AUTHENTICATOR_PASSWORD;
  if (!password) {
    console.log(
      "[migrate] PGRST_AUTHENTICATOR_PASSWORD not set — skipping authenticator role setup (legacy install / OSS deploy)",
    );
    return;
  }
  // newGuid() output is alphanumeric + hyphen. Anything else would risk
  // DDL injection because CREATE/ALTER ROLE don't support parameterized
  // queries. Fail loudly rather than silently quote-escape something we
  // didn't expect.
  if (!/^[A-Za-z0-9-]+$/.test(password)) {
    throw new Error(
      "PGRST_AUTHENTICATOR_PASSWORD must be alphanumeric+hyphen (newGuid format)",
    );
  }

  const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    const existsRow = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') AS exists",
    );
    const exists = Boolean(existsRow.rows[0]?.exists);
    if (exists) {
      await client.query(
        `ALTER ROLE authenticator WITH LOGIN NOINHERIT PASSWORD '${password}'`,
      );
      console.log("[migrate] authenticator role: password refreshed");
    } else {
      await client.query(
        `CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD '${password}'`,
      );
      console.log("[migrate] authenticator role: created");
    }
    // Membership in the role tier (created by 0005_postgres_roles.sql).
    // GRANT is idempotent — no-op if already a member.
    await client.query("GRANT web_anon TO authenticator");
    await client.query("GRANT authenticated TO authenticator");
    await client.query("GRANT service_role TO authenticator");
    console.log("[migrate] authenticator role: memberships ensured");
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  const databaseUrl = await getDatabaseUrl();
  const exitCode = await runNodePgMigrate(databaseUrl);

  if (exitCode !== 0) {
    throw new Error(`node-pg-migrate exited with code ${exitCode}`);
  }

  await ensureAuthenticatorRole(databaseUrl);
  await reloadPostgrestSchemaCache(databaseUrl);
}

main().catch((error) => {
  console.error("Migration job failed", error);
  process.exit(1);
});
