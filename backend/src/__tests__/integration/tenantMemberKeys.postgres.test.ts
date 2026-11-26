// Regression test for migration 0202 (hybrid key mode and member key models).
// Replays the real numbered migrations with the standard runner as a
// non-superuser, non-BYPASSRLS migration role, then calls cp_set_entitlements.
// Opt in exactly as tenantDebug.postgres.test.ts does:
//
//   docker run -d --name mike-rls-test -e POSTGRES_PASSWORD=pw -p 55441:5432 postgres:16
//   $env:MIKE_TENANT_RLS_TEST_ADMIN_URL = "postgres://postgres:pw@localhost:55441/postgres"
//   npx vitest run src/__tests__/integration/tenantMemberKeys.postgres.test.ts --testTimeout=60000
//   docker rm -f mike-rls-test
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrationCommand } from "../../scripts/migrationLedger";

const adminUrl = process.env.MIKE_TENANT_RLS_TEST_ADMIN_URL;
const quiet = { info: () => {}, warn: () => {}, error: console.error };
const MIGRATOR = "mike_rls_test_migrator";

describe.skipIf(!adminUrl)("cp_set_entitlements hybrid / memberKeyModels (0202)", () => {
  const database = `mike_rls_test_${process.pid}_${Date.now()}`;
  const password = randomBytes(12).toString("hex");
  let admin: Client;
  let db: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname='web_anon') then create role web_anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
      if not exists (select 1 from pg_roles where rolname='${MIGRATOR}') then
        create role ${MIGRATOR} login nosuperuser nobypassrls createrole createdb;
      end if;
    end $$`);
    await admin.query(`alter role ${MIGRATOR} with login password '${password}' nosuperuser nobypassrls createrole createdb`);
    await admin.query(`grant web_anon, authenticated, service_role to ${MIGRATOR} with admin option`);
    await admin.query(`create database ${database} owner ${MIGRATOR}`);
    const url = new URL(adminUrl!);
    url.username = MIGRATOR; url.password = password; url.pathname = `/${database}`;
    db = new Client({ connectionString: url.toString() });
    await db.connect();
    await expect(runMigrationCommand(db, { kind: "up" }, path.resolve(__dirname, "../../../migrations"), quiet)).resolves.toBe(0);
  }, 600_000);

  afterAll(async () => {
    await db?.end().catch(() => {});
    if (admin) {
      await admin.query(`drop database if exists ${database} with (force)`).catch(() => {});
      await admin.end().catch(() => {});
    }
  });

  // The control plane's functions are also granted to service_role (0194).
  beforeEach(async () => {
    await db.query("begin");
    await db.query("set local role service_role");
    await db.query(`insert into public.tenants (tenant_id, status) values ('mk-a','active')`);
  });
  afterEach(async () => { await db.query("rollback"); });

  const setEntitlements = (value: unknown) =>
    db.query("select public.cp_set_entitlements('mk-a', $1::jsonb)", [JSON.stringify(value)]);
  const stored = async () => (await db.query(
    "select key_mode, member_key_models from public.tenant_settings where tenant_id='mk-a'")).rows[0];
  const code = (promise: Promise<unknown>) => promise.then(() => "ok", (error: { code?: string }) => error.code);

  it("accepts hybrid and stores memberKeyModels, null and [] meaning none", async () => {
    await setEntitlements({ keyMode: "hybrid", memberKeyModels: ["claude-sonnet-4-5", "openrouter/openai/gpt-5"] });
    expect(await stored()).toEqual({ key_mode: "hybrid", member_key_models: ["claude-sonnet-4-5", "openrouter/openai/gpt-5"] });
    await setEntitlements({ memberKeyModels: [] });
    expect(await stored()).toEqual({ key_mode: "hybrid", member_key_models: [] });
    await setEntitlements({ memberKeyModels: null });
    expect(await stored()).toEqual({ key_mode: "hybrid", member_key_models: null });
  });

  it("refuses an unknown key mode and invalid memberKeyModels with 22023", async () => {
    await db.query("savepoint s");
    for (const value of [
      { keyMode: "member" },
      { memberKeyModels: "claude-sonnet-4-5" },
      { memberKeyModels: [""] },
      { memberKeyModels: [1] },
    ]) {
      expect(await code(setEntitlements(value))).toBe("22023");
      await db.query("rollback to savepoint s");
    }
  });

  it("keeps the table constraint in step with the function", async () => {
    await db.query("insert into public.tenant_settings (tenant_id, key_mode) values ('mk-a', 'hybrid')");
    await db.query("savepoint s");
    expect(await code(db.query("update public.tenant_settings set key_mode='member' where tenant_id='mk-a'"))).toBe("23514");
    await db.query("rollback to savepoint s");
    const { rows } = await db.query(`select
      has_function_privilege('control_plane', 'public.cp_set_entitlements(text,jsonb)', 'EXECUTE') as cp,
      has_function_privilege('tenant_app', 'public.cp_set_entitlements(text,jsonb)', 'EXECUTE') as app,
      has_column_privilege('tenant_app', 'public.tenant_settings', 'member_key_models', 'SELECT') as app_read,
      (select count(*) from app.tenant_rls_gaps())::int as rls_gaps,
      (select count(*) from app.control_plane_gaps())::int as cp_gaps`);
    expect(rows[0]).toEqual({ cp: true, app: false, app_read: true, rls_gaps: 0, cp_gaps: 0 });
  });
});
