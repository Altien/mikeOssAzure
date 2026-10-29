// Dev adaptation of upstream 89dc8323: every local database uses the same
// numbered migrations and pgmigrations integrity helper as Azure deployment.
// No schema.sql, secondary ledger, implicit baseline or broad re-grant exists.
const fs = require("fs");
const path = require("path");
const { runSqlFile } = require("./sql");

async function pgValue(withPg, sql) {
  return withPg(async (client) => {
    const row = (await client.query(sql)).rows?.[0];
    return row ? String(Object.values(row)[0]) : "";
  });
}
async function pgExec(withPg, sql, label) {
  try { await withPg((client) => client.query(sql)); }
  catch (error) { throw new Error(`${label ?? "sql"} failed: ${String(error.message).slice(0, 2000)}`); }
}
async function pgExecFile(withPg, sql, label) {
  try { await withPg((client) => runSqlFile((text) => client.query(text), sql)); }
  catch (error) { throw new Error(`${label ?? "sql"} failed: ${String(error.message).slice(0, 2000)}`); }
}
async function bootstrapRoles(withPg, dbPassword) {
  const password = dbPassword.replace(/'/g, "''");
  await pgExec(withPg, `
    do $$ begin
      if not exists(select from pg_roles where rolname='web_anon') then create role web_anon nologin; end if;
      if not exists(select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      if not exists(select from pg_roles where rolname='service_role') then create role service_role nologin; end if;
      if not exists(select from pg_roles where rolname='authenticator') then create role authenticator login noinherit; end if;
    end $$;
    alter role authenticator with login noinherit password '${password}';
    grant web_anon, authenticated, service_role to authenticator;
  `, "role bootstrap");
}
function listMigrations(backendDir) {
  return fs.readdirSync(path.join(backendDir, "migrations"))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/i.test(name)).sort();
}
async function applySchema(withPg, backendDir, status = () => {}) {
  const helper = path.join(backendDir, "dist/scripts/migrationLedger.js");
  if (!fs.existsSync(helper)) throw new Error("The numbered migration runner is missing. Rebuild or reinstall Mike.");
  const { runMigrationCommand } = require(helper);
  const code = await withPg((client) => runMigrationCommand(client, { kind: "up" },
    path.join(backendDir, "migrations"), {
      info: (message) => status(String(message)),
      warn: (message) => console.warn("[local migrations]", message),
      error: (message) => console.error("[local migrations]", message),
    }));
  if (code !== 0) throw new Error("Local numbered migrations did not complete");
}
module.exports = { pgValue, pgExec, pgExecFile, bootstrapRoles, listMigrations, applySchema };
