// Regression test for migration 0203 (cp_models) and the migration job's
// catalogue publish. Replays the real numbered migrations with the standard
// runner as a non-superuser, non-BYPASSRLS migration role. Opt in exactly as
// tenantMemberKeys.postgres.test.ts does:
//
//   docker run -d --name mike-rls-test -e POSTGRES_PASSWORD=pw -p 55441:5432 postgres:16
//   $env:MIKE_TENANT_RLS_TEST_ADMIN_URL = "postgres://postgres:pw@localhost:55441/postgres"
//   npx vitest run src/__tests__/integration/modelCatalog.postgres.test.ts --testTimeout=60000
//   docker rm -f mike-rls-test
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrationCommand } from "../../scripts/migrationLedger";
import { memberKeyModelCatalog, publishModelCatalog } from "../../lib/llm/modelCatalog";

const adminUrl = process.env.MIKE_TENANT_RLS_TEST_ADMIN_URL;
const quiet = { info: () => {}, warn: () => {}, error: console.error };
const MIGRATOR = "mike_rls_test_migrator";

describe.skipIf(!adminUrl)("cp_models model catalogue (0203)", () => {
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
    // The migrator's implicit creator grant carries no SET option.
    await admin.query(`grant control_plane to ${MIGRATOR} with set true`);
  }, 600_000);

  afterAll(async () => {
    await db?.end().catch(() => {});
    if (admin) {
      await admin.query(`revoke set option for control_plane from ${MIGRATOR}`).catch(() => {});
      await admin.query(`drop database if exists ${database} with (force)`).catch(() => {});
      await admin.end().catch(() => {});
    }
  });

  const code = (promise: Promise<unknown>) => promise.then(() => "ok", (error: { code?: string }) => error.code);

  it("publishes this build's models, replacing the previous rows", async () => {
    await db.query("insert into app.model_catalog values ('retired-model', 'claude', 'retired-model', 0)");
    const expected = memberKeyModelCatalog();
    expect(await publishModelCatalog(db)).toBe(expected.length);
    expect(await publishModelCatalog(db)).toBe(expected.length);
    const { rows } = await db.query("select model_id, provider, label from public.cp_models");
    expect(rows).toEqual(expected.map((m) => ({ model_id: m.modelId, provider: m.provider, label: m.label })));
  });

  it("lets control_plane read the view but not the table", async () => {
    await db.query("begin");
    try {
      await db.query("set local role control_plane");
      const { rows } = await db.query("select count(*)::int as n from public.cp_models");
      expect(rows[0].n).toBeGreaterThan(0);
      await db.query("savepoint s");
      for (const sql of [
        "insert into app.model_catalog values ('x', 'claude', 'x', 0)",
        "delete from app.model_catalog",
        "select * from app.model_catalog",
        "insert into public.cp_models values ('x', 'claude', 'x')",
      ]) {
        expect(await code(db.query(sql))).toBe("42501");
        await db.query("rollback to savepoint s");
      }
    } finally {
      await db.query("rollback");
    }
    const { rows } = await db.query(`select
      has_table_privilege('control_plane', 'public.cp_models', 'SELECT') as cp_read,
      has_table_privilege('control_plane', 'app.model_catalog', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') as cp_table,
      has_table_privilege('tenant_app', 'public.cp_models', 'SELECT') as app_read,
      (select count(*) from app.tenant_rls_gaps())::int as rls_gaps,
      (select count(*) from app.control_plane_gaps())::int as cp_gaps`);
    expect(rows[0]).toEqual({ cp_read: true, cp_table: false, app_read: false, rls_gaps: 0, cp_gaps: 0 });
  });
});
