// Regression test for migration 0201 (per-tenant debug logging switch).
// Replays the real numbered migrations with the standard runner as a
// non-superuser, non-BYPASSRLS migration role, then calls the control-plane
// functions. Opt in exactly as namedMicrosoftMembers.postgres.test.ts does:
//
//   docker run -d --name mike-rls-test -e POSTGRES_PASSWORD=pw -p 55441:5432 postgres:16
//   $env:MIKE_TENANT_RLS_TEST_ADMIN_URL = "postgres://postgres:pw@localhost:55441/postgres"
//   npx vitest run src/__tests__/integration/tenantDebug.postgres.test.ts --testTimeout=60000
//   docker rm -f mike-rls-test
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrationCommand } from "../../scripts/migrationLedger";

const adminUrl = process.env.MIKE_TENANT_RLS_TEST_ADMIN_URL;
const quiet = { info: () => {}, warn: () => {}, error: console.error };
const MIGRATOR = "mike_rls_test_migrator";

describe.skipIf(!adminUrl)("cp_set_tenant_debug / cp_clear_tenant_debug (0201)", () => {
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

  beforeEach(async () => {
    await db.query("begin");
    await db.query("set local role service_role");
    await db.query(`insert into public.tenants (tenant_id, status) values ('dbg-a','active')`);
  });
  afterEach(async () => { await db.query("rollback"); });

  const code = (promise: Promise<unknown>) => promise.then(() => "ok", (error: { code?: string }) => error.code);
  // now() is the transaction start, so the expected end is exact (compared in
  // SQL: JavaScript dates drop the microseconds).
  it("turns debug on for 120 minutes by default and returns the stored end", async () => {
    const returned = await db.query("select public.cp_set_tenant_debug('dbg-a') = now() + interval '2 hours' as exact");
    const stored = await db.query("select debug_log_until = now() + interval '2 hours' as exact from public.tenants where tenant_id='dbg-a'");
    expect([returned.rows[0].exact, stored.rows[0].exact]).toEqual([true, true]);
  });

  it("accepts 1 and 1440 minutes, and rejects 0, 1441 and null with 22023", async () => {
    for (const minutes of [1, 1440]) {
      const { rows } = await db.query("select public.cp_set_tenant_debug('dbg-a', $1) = now() + make_interval(mins => $1) as exact", [minutes]);
      expect(rows[0].exact).toBe(true);
    }
    await db.query("savepoint s");
    for (const minutes of [0, 1441, null]) {
      expect(await code(db.query("select public.cp_set_tenant_debug('dbg-a', $1)", [minutes]))).toBe("22023");
      await db.query("rollback to savepoint s");
    }
  });

  it("raises 23503 for an unknown tenant from both functions", async () => {
    await db.query("savepoint s");
    expect(await code(db.query("select public.cp_set_tenant_debug('missing')"))).toBe("23503");
    await db.query("rollback to savepoint s");
    expect(await code(db.query("select public.cp_clear_tenant_debug('missing')"))).toBe("23503");
    await db.query("rollback to savepoint s");
  });

  it("clears the switch, idempotently", async () => {
    await db.query("select public.cp_set_tenant_debug('dbg-a', 30)");
    await db.query("select public.cp_clear_tenant_debug('dbg-a')");
    await db.query("select public.cp_clear_tenant_debug('dbg-a')");
    const { rows } = await db.query("select debug_log_until from public.tenants where tenant_id='dbg-a'");
    expect(rows[0].debug_log_until).toBeNull();
  });

  it("is executable by control_plane only, and leaves no platform gaps", async () => {
    const { rows } = await db.query(`select
      has_function_privilege('control_plane', 'public.cp_set_tenant_debug(text,integer)', 'EXECUTE') as cp_set,
      has_function_privilege('control_plane', 'public.cp_clear_tenant_debug(text)', 'EXECUTE') as cp_clear,
      has_function_privilege('tenant_app', 'public.cp_set_tenant_debug(text,integer)', 'EXECUTE') as app_set,
      has_function_privilege('tenant_app', 'public.cp_clear_tenant_debug(text)', 'EXECUTE') as app_clear,
      has_function_privilege('authenticated', 'public.cp_set_tenant_debug(text,integer)', 'EXECUTE') as auth_set,
      has_function_privilege('authenticated', 'public.cp_clear_tenant_debug(text)', 'EXECUTE') as auth_clear,
      has_column_privilege('control_plane', 'public.tenants', 'debug_log_until', 'SELECT') as cp_column,
      (select count(*) from app.tenant_rls_gaps())::int as rls_gaps,
      (select count(*) from app.control_plane_gaps())::int as cp_gaps`);
    expect(rows[0]).toEqual({
      cp_set: true, cp_clear: true, app_set: false, app_clear: false,
      auth_set: false, auth_clear: false, cp_column: false, rls_gaps: 0, cp_gaps: 0,
    });
  });
});
