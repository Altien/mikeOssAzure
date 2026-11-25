// tenant_app must be able to execute every tenant function in public. The
// request client runs as tenant_app (0180); a migration that
// DROP+CREATEs a function, or adds one after 0180's blanket grant, silently
// loses that grant and the RPC fails only in production (0218 stripped
// get_projects_overview this way; 0250 restored it). Replays the real
// numbered migrations as a non-superuser. Opt in as the other
// *.postgres.test.ts files do:
//
//   docker run -d --name mike-rls-test -e POSTGRES_PASSWORD=pw -p 55441:5432 postgres:16
//   $env:MIKE_TENANT_RLS_TEST_ADMIN_URL = "postgres://postgres:pw@localhost:55441/postgres"
//   npx vitest run src/__tests__/integration/tenantAppExecute.postgres.test.ts --testTimeout=60000
//   docker rm -f mike-rls-test
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrationCommand } from "../../scripts/migrationLedger";

const adminUrl = process.env.MIKE_TENANT_RLS_TEST_ADMIN_URL;
const quiet = { info: () => {}, warn: () => {}, error: console.error };
const MIGRATOR = "mike_rls_test_migrator";

describe.skipIf(!adminUrl)("tenant_app execute grants", () => {
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

  it("grants tenant_app execute on every tenant function", async () => {
    // 0180's policy: tenant_app runs every public function except platform
    // control (owned by service_role) and job control. A new function that
    // lands here either needs `grant execute ... to tenant_app` or, if it is
    // deliberately service-only, a place in this list.
    const serviceOnly = [
      "claim_db_job", "claim_db_jobs", "defer_db_job", "finish_db_job", "renew_db_job",
      "stamp_runtime_metadata", "publish_credit_prices",
    ];
    const { rows } = await db.query(`
      select p.oid::regprocedure::text as fn
        from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and pg_get_userbyid(p.proowner) <> 'service_role'
         and p.proname <> all ($1::text[])
         and not exists (select 1 from pg_depend d
                          where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
         and not has_function_privilege('tenant_app', p.oid, 'EXECUTE')
       order by 1`, [serviceOnly]);
    expect(rows.map((row) => row.fn)).toEqual([]);
  });
});
