// Regression test for migration 0198 (named Microsoft members). Replays the
// real numbered migrations with the standard runner as a non-superuser,
// non-BYPASSRLS migration role, then calls the control-plane functions.
//
// Opt in exactly as uploadClaimsAsTenant.postgres.test.ts describes:
//
//   docker run -d --name mike-rls-test -e POSTGRES_PASSWORD=pw -p 55441:5432 postgres:16
//   $env:MIKE_TENANT_RLS_TEST_ADMIN_URL = "postgres://postgres:pw@localhost:55441/postgres"
//   npx vitest run src/__tests__/integration/namedMicrosoftMembers.postgres.test.ts --testTimeout=60000
//   docker rm -f mike-rls-test
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrationCommand } from "../../scripts/migrationLedger";

const adminUrl = process.env.MIKE_TENANT_RLS_TEST_ADMIN_URL;
const quiet = { info: () => {}, warn: () => {}, error: console.error };
const MIGRATOR = "mike_rls_test_migrator";
const CONSUMERS = "9188040d-6c67-4c5b-b112-36a304b66dad";
const DIRECTORY = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const OBJECT = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

describe.skipIf(!adminUrl)("cp_add_directory_member (0198)", () => {
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
    await db.query(`insert into public.tenants (tenant_id, status) values ('nm-a','active')`);
  });
  afterEach(async () => { await db.query("rollback"); });

  const add = (tenant: string, directory: string | null, object: string | null, role = "Member") =>
    db.query("select public.cp_add_directory_member($1, $2, $3, $4)", [tenant, directory, object, role]);
  const code = (promise: Promise<unknown>) => promise.then(() => "ok", (error: { code?: string }) => error.code);

  it("stores a named Microsoft member with the normalised directory and object ID", async () => {
    await add("nm-a", ` ${DIRECTORY.toUpperCase()} `, OBJECT.toUpperCase(), "TenantAdmin");
    const { rows } = await db.query("select user_id, tenant_id, role, identity_kind, directory_id from public.tenant_memberships");
    expect(rows).toEqual([{ user_id: OBJECT, tenant_id: "nm-a", role: "TenantAdmin", identity_kind: "microsoft", directory_id: DIRECTORY }]);
  });

  it("raises 23503 for an unknown tenant, 23505 for a duplicate person and 22023 for invalid input", async () => {
    await db.query("savepoint s");
    expect(await code(add("missing", DIRECTORY, OBJECT))).toBe("23503");
    await db.query("rollback to savepoint s");
    await add("nm-a", DIRECTORY, OBJECT);
    expect(await code(add("nm-a", DIRECTORY, OBJECT))).toBe("23505");
    await db.query("rollback to savepoint s");
    for (const [directory, object, role] of [[null, OBJECT, "Member"], [DIRECTORY, "not-a-guid", "Member"], [DIRECTORY, OBJECT, "Owner"]]) {
      expect(await code(add("nm-a", directory, object, role!))).toBe("22023");
      await db.query("rollback to savepoint s");
    }
  });

  it("refuses to link the personal-account directory", async () => {
    expect(await code(db.query("select public.cp_link_identity_source($1, 'nm-a')", [` ${CONSUMERS.toUpperCase()} `]))).toBe("22023");
  });

  // Migration 0204: a group policy can only elevate a named member, so setting one must not sign them out.
  it("cp_set_group_policies keeps named members signed in and still signs directory-link members out", async () => {
    const LINKED_DIRECTORY = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
    const LINKED_OBJECT = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
    const GROUP = "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee";
    await add("nm-a", DIRECTORY, OBJECT);
    await db.query("select public.cp_link_identity_source($1, 'nm-a')", [LINKED_DIRECTORY]);
    await db.query("select public.mirror_enterprise_member('nm-a', $1, $2, 'Member')", [LINKED_OBJECT, LINKED_DIRECTORY]);
    for (const user of [OBJECT, LINKED_OBJECT]) {
      await db.query(`insert into public.auth_sessions (session_hash, provider, user_id, credential_cipher, token_expires_at, expires_at)
        values ($1, 'entra', $1, 'x', now() + interval '1 hour', now() + interval '1 day')`, [user]);
    }
    await db.query("select public.cp_set_group_policies('nm-a', $1::jsonb)", [JSON.stringify([{ groupObjectId: GROUP, role: "TenantAdmin" }])]);
    const { rows } = await db.query("select user_id, revoked_at is not null as revoked from public.auth_sessions order by user_id");
    expect(rows).toEqual([{ user_id: OBJECT, revoked: false }, { user_id: LINKED_OBJECT, revoked: true }]);
    const policies = await db.query("select group_object_id, role from public.tenant_group_policies where tenant_id = 'nm-a'");
    expect(policies.rows).toEqual([{ group_object_id: GROUP, role: "TenantAdmin" }]);
  });

  it("is executable by the control_plane login and leaves no platform gaps", async () => {
    const { rows } = await db.query(`select has_function_privilege('control_plane', 'public.cp_add_directory_member(text,text,text,text)', 'EXECUTE') as cp,
      has_function_privilege('tenant_app', 'public.cp_add_directory_member(text,text,text,text)', 'EXECUTE') as app,
      (select count(*) from app.tenant_rls_gaps())::int as gaps`);
    expect(rows[0]).toEqual({ cp: true, app: false, gaps: 0 });
  });
});
