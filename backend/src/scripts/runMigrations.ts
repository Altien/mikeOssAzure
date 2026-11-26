import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { createPlatformSupabase } from "../lib/supabase";
import { initStorage } from "../lib/storage";
import { syncWorkflowCatalog } from "../lib/workflowCatalogSync";
import { resolveProviderSecret } from "../lib/envSecrets";
import { getMigrationDatabaseUrl } from "../lib/deploymentDatabase";
import { deployStampRuntime } from "../lib/stampDeployment";
import { publishModelCatalog } from "../lib/llm/modelCatalog";
import { assertInstallTenantGate } from "./installTenantGate";
import { assertDirectMigrationConnection, parseMigrationCommand, runMigrationCommand } from "./migrationLedger";


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

  const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000 });
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
    // Multi-tenant 008: tenant traffic switches to tenant_app (created by
    // migration 0180, which runs before this on a fresh install, when
    // authenticator does not exist yet).
    await client.query(
      "DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_app') THEN GRANT tenant_app TO authenticator; END IF; END $$",
    );
    console.log("[migrate] authenticator role: memberships ensured");
  } finally {
    await client.end().catch(() => {});
  }
}

/** One direct PostgreSQL session serializes all cooperating migration jobs. */
async function provisionAuthSecrets(databaseUrl: string): Promise<void> {
  const mode = process.env.AUTH_SECRET_PROVISIONING_MODE;
  if (mode === "local") return;
  if (mode !== "keyvault" || !process.env.KEY_VAULT_NAME || !process.env.AZURE_CLIENT_ID) {
    throw new Error("Auth secret provisioning requires explicit Key Vault mode, vault and managed identity");
  }
  const vault = new SecretClient(
    `https://${process.env.KEY_VAULT_NAME}.vault.azure.net/`,
    new DefaultAzureCredential({ managedIdentityClientId: process.env.AZURE_CLIENT_ID }),
  );
  const client = new Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000 });
  await client.connect();
  const lockKey = "mike-auth-secret-provision-v1";
  try {
    await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
    for (const name of [
      "auth-state-secret", "auth-session-encryption-secret", "auth-handoff-encryption-secret",
    ]) {
      let existing: string | undefined;
      try { existing = (await vault.getSecret(name, { abortSignal: AbortSignal.timeout(15_000) })).value; }
      catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      }
      if (!existing || existing === "__unset__") {
        const created = randomBytes(32).toString("base64url");
        await vault.setSecret(name, created, { abortSignal: AbortSignal.timeout(15_000) });
        console.log(`[migrate] auth secret created: ${name}`);
      } else {
        console.log(`[migrate] auth secret retained: ${name}`);
      }
      const confirmed = (await vault.getSecret(name, { abortSignal: AbortSignal.timeout(15_000) })).value;
      if (!confirmed || confirmed === "__unset__") throw new Error(`Auth secret is unusable: ${name}`);
      if (name !== "auth-state-secret" && Buffer.from(confirmed, "base64url").length !== 32) {
        throw new Error(`Auth encryption secret has invalid length: ${name}`);
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]).catch(() => {});
    await client.end().catch(() => {});
  }
}

async function main() {
  const command = parseMigrationCommand(process.argv.slice(2));
  const databaseUrl = await getMigrationDatabaseUrl();
  assertDirectMigrationConnection(databaseUrl);
  const client = new Client({ connectionString: databaseUrl, application_name: "mike-migrate" });
  try {
    await client.connect();
    process.exitCode = await runMigrationCommand(client, command, "migrations", console, {
      beforeApply: (pending) => assertInstallTenantGate(client, pending),
    });
  } finally {
    await client.end().catch(() => {});
  }
  // Status/recovery commands inspect or record schema only. Deployment and
  // local upgrade entrypoints keep their existing provisioning sequence.
  if (command.kind !== "up" || process.exitCode) return;

  // Stamp mode/identity and future ledger partitions are deployment work,
  // completed by the migration owner before an API revision is activated.
  const deployment = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 15_000 });
  try {
    await deployment.connect();
    const created = await deployStampRuntime(deployment);
    console.log("[migrate] stamp metadata configured; ledger partitions created: " + created);
    // The control plane's model catalogue (cp_models) follows the image.
    const models = await publishModelCatalog(deployment);
    console.log("[migrate] model catalogue published: " + models + " models");
  } finally { await deployment.end().catch(() => {}); }
  await ensureAuthenticatorRole(databaseUrl);
  await provisionAuthSecrets(databaseUrl);
  await reloadPostgrestSchemaCache(databaseUrl);
  // The same deployment job publishes the catalogue after its tables/RPCs
  // exist and before the backend revision is activated. Reference bytes are
  // uploaded first; a failed sync leaves the previous DB catalogue active and
  // fails the job, so an empty or partial catalogue cannot be deployed.
  // Catalogue assets upload through the storage facade, which stays disabled
  // until the configured adapter is resolved (Key Vault first).
  await initStorage();
  const githubToken = await resolveProviderSecret("mike-workflows-github-token");
  const result = await syncWorkflowCatalog(
    createPlatformSupabase(),
    githubToken ? { githubToken } : {},
  );
  console.log(
    `[migrate] catalogue active: ${result.workflows} workflows, ` +
      `${result.assets} assets, source ${result.sourceCommit}`,
  );
}

main().catch((error) => {
  console.error("Migration job failed", error);
  process.exit(1);
});
