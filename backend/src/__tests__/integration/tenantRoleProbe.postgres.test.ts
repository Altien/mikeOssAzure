// The stream-run startup check against real PostgreSQL and the real migrations:
// a login with tenant_app starts, one without it stops with the guidance, the
// empty database passes, and the reserved pooled claim sees no tenant's rows.
//
// Opt in with a superuser URL to a DISPOSABLE PostgreSQL 16 server:
//
//   docker run -d --name mike-rls-test -e POSTGRES_PASSWORD=pw -p 55441:5432 postgres:16
//   $env:MIKE_TENANT_RLS_TEST_ADMIN_URL = "postgres://postgres:pw@localhost:55441/postgres"
//   npx vitest run src/__tests__/integration/tenantRoleProbe.postgres.test.ts --testTimeout=60000
//   docker rm -f mike-rls-test
//
// It creates (if missing) the cluster roles web_anon, authenticated, service_role
// (BYPASSRLS) and mike_rls_test_migrator, creates and drops its own database and
// its two logins, and never touches another database.
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamRunCluster } from "../../lib/streamRunCluster";
import { tableGrantGuidance, TENANT_PROBE_ID } from "../../lib/tenantDatabaseProbe";
import { databaseChecks, withReadOnlySession } from "../../modules/platform/platform.healthDatabase";
import { runMigrationCommand } from "../../scripts/migrationLedger";

const adminUrl = process.env.MIKE_TENANT_RLS_TEST_ADMIN_URL;
const quiet = { info: () => {}, warn: () => {}, error: console.error };
const MIGRATOR = "mike_rls_test_migrator";
const GRANTED = "mike_rls_test_granted";
const DENIED = "mike_rls_test_denied";
const NO_PLATFORM = "mike_rls_test_no_platform";
const RELAY_KEY = Buffer.alloc(32, 7);

describe.skipIf(!adminUrl)("tenant role startup check on real PostgreSQL", () => {
  const database = `mike_rls_test_${process.pid}_${Date.now()}`;
  const password = randomBytes(12).toString("hex");
  let admin: Client;
  let db: Client;

  const urlFor = (user: string) => {
    const url = new URL(adminUrl!);
    url.username = user;
    url.password = password;
    url.pathname = `/${database}`;
    return url.toString();
  };

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
    db = new Client({ connectionString: urlFor(MIGRATOR) });
    await db.connect();
    const migrations = path.resolve(__dirname, "../../../migrations");
    await expect(runMigrationCommand(db, { kind: "up" }, migrations, quiet)).resolves.toBe(0);
    // Logins that did not run the migrations, as a separate PostgREST login would be.
    for (const login of [GRANTED, DENIED]) {
      await admin.query(`drop role if exists ${login}`);
      await admin.query(`create role ${login} login noinherit password '${password}'`);
      await admin.query(`grant service_role to ${login}`);
    }
    await admin.query(`grant tenant_app to ${GRANTED}`);
    await admin.query(`drop role if exists ${NO_PLATFORM}`);
    await admin.query(`create role ${NO_PLATFORM} login noinherit password '${password}'`);
  }, 600_000);

  afterAll(async () => {
    await db?.end().catch(() => {});
    if (admin) {
      await admin.query(`drop database if exists ${database} with (force)`).catch(() => {});
      await admin.query(`drop role if exists ${GRANTED}`).catch(() => {});
      await admin.query(`drop role if exists ${DENIED}`).catch(() => {});
      await admin.query(`drop role if exists ${NO_PLATFORM}`).catch(() => {});
      await admin.end().catch(() => {});
    }
  });

  it("starts for a login with the tenant role, on an empty database", async () => {
    const cluster = await StreamRunCluster.startForTests(urlFor(GRANTED), RELAY_KEY);
    await cluster.close();
  });

  it("stops for a login without it, with the code and the grant to run", async () => {
    const error = await StreamRunCluster.startForTests(urlFor(DENIED), RELAY_KEY)
      .catch((caught: Error) => caught) as Error;
    expect(error.message).toContain("code 42501");
    expect(error.message).toContain("GRANT tenant_app TO <login>");
    expect(error.message).not.toContain(password);
  });

  describe("the health page's direct-session SQL", () => {
    const run = async (id: string) => {
      const check = databaseChecks().find((candidate) => candidate.id === id);
      if (!check) throw new Error(`no check ${id}`);
      return check.run(new AbortController().signal);
    };

    beforeEach(() => {
      vi.stubEnv("AUTH_PROVIDER", "local");
      vi.stubEnv("KEY_VAULT_NAME", "");
      vi.stubEnv("STREAM_RUN_DATABASE_URL", urlFor(GRANTED));
    });
    afterEach(() => { vi.unstubAllEnvs(); });

    it("runs in a transaction that really is read-only, even as service_role", async () => {
      const session = await withReadOnlySession(new AbortController().signal, async (client) => {
        const { rows } = await client.query("show transaction_read_only");
        await client.query("set local role service_role");
        const write = await client.query("insert into public.tenants (tenant_id, status) values ('never','active')")
          .catch((error: { code?: string }) => error);
        return { readOnly: rows[0].transaction_read_only, code: (write as { code?: string }).code };
      });
      expect(session?.value).toEqual({ readOnly: "on", code: "25006" });
      const { rows } = await db.query("select count(*)::int as n from public.tenants where tenant_id = 'never'");
      expect(rows[0].n).toBe(0);
    });

    it("reads the migration history as a login that did not run the migrations", async () => {
      expect(await run("db.migrations")).toMatchObject({ status: "pass" });
    });

    it("finds no RLS gaps through app.tenant_rls_gaps()", async () => {
      expect(await run("db.rls-gaps")).toEqual({ status: "pass", detail: "No gaps." });
    });

    it("reads rolbypassrls from pg_roles", async () => {
      expect(await run("db.service-role-bypass")).toMatchObject({ status: "pass", detail: "pg_roles shows service_role has BYPASSRLS." });
    });

    it("passes the stream login with the tenant role, on the same transaction", async () => {
      expect(await run("db.stream-login")).toMatchObject({ status: "pass" });
    });

    it("reports a real refused role, with the grant", async () => {
      vi.stubEnv("STREAM_RUN_DATABASE_URL", urlFor(DENIED));
      const outcome = await run("db.stream-login");
      expect(outcome.status).toBe("fail");
      expect(outcome.detail).toContain("could not use role tenant_app (code 42501)");
      expect(outcome.remediation).toContain("GRANT tenant_app TO <login>");
    });

    it("tells a refused table read from a refused role, on the page and at startup", async () => {
      await db.query("revoke all on public.stream_runs from tenant_app");
      try {
        const outcome = await run("db.stream-login");
        expect(outcome.status).toBe("fail");
        expect(outcome.detail).toContain("Role tenant_app could not read public.stream_runs (code 42501)");
        expect(outcome.remediation).toContain("lacks a grant on public.stream_runs");
        expect(outcome.remediation).toContain("If it applies nothing");
        expect(outcome.remediation).not.toContain("TO <login>");

        const error = await StreamRunCluster.startForTests(urlFor(GRANTED), RELAY_KEY)
          .catch((caught: Error) => caught) as Error;
        expect(error.message).toContain("role tenant_app could not read public.stream_runs (code 42501)");
        expect(error.message).not.toContain("TO <login>");

        // The migration job would apply nothing here, so the advice has to be enough.
        const statement = /GRANT [^.]+\.\w+ TO tenant_app/.exec(outcome.remediation ?? "")?.[0];
        expect(statement).toBeDefined();
        await db.query(statement!);
        expect(await run("db.stream-login")).toMatchObject({ status: "pass" });
      } finally {
        await db.query("grant select, insert, update, delete on public.stream_runs to tenant_app");
      }
    });

    it.each([
      ["tenant_app", "public.stream_runs"],
      ["service_role", "public.stream_runs"],
      ["tenant_app", "public.tenants"],
      ["service_role", "public.tenants"],
      ["service_role", "public.pgmigrations"],
    ])("advises for %s on %s only what the migrations gave it", async (role, table) => {
      const named = /GRANT (.+) ON /.exec(tableGrantGuidance(role, table))?.[1].split(", ") ?? [];
      const all = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
      const expected = named[0] === "ALL" ? all : named;
      const { rows } = await db.query<{ privilege: string }>(
        "select privilege from unnest($3::text[]) as privilege where has_table_privilege($1::name, $2::text, privilege)",
        [role, table, all],
      );
      const held = rows.map((row) => row.privilege);
      expect(held).toEqual(expect.arrayContaining(expected));
      // Only tenant_app is deliberately narrow: re-granting more would widen it.
      if (role === "tenant_app") expect(held.sort()).toEqual([...expected].sort());
    });

    it("asks for service_role when a login without it reads the migration history", async () => {
      vi.stubEnv("STREAM_RUN_DATABASE_URL", urlFor(NO_PLATFORM));
      const outcome = await run("db.migrations");
      expect(outcome.status).toBe("warn");
      expect(outcome.detail).toContain("code 42501");
      expect(outcome.remediation).toContain("GRANT service_role TO <login>");
    });

    it("reports a real bad password as a connection failure, with no grant", async () => {
      const url = new URL(urlFor(GRANTED));
      url.password = "not-the-password";
      vi.stubEnv("STREAM_RUN_DATABASE_URL", url.toString());
      const outcome = await run("db.stream-login");
      expect(outcome.status).toBe("fail");
      expect(outcome.detail).toContain("Could not connect with the stream-run login (code 28P01)");
      expect(outcome.remediation).not.toContain("GRANT");
      expect(outcome.remediation).not.toContain("tenant-rls-enforced");
    });
  });

  it("shows the reserved claim no tenant's rows, so the pooled probe reads nothing", async () => {
    await db.query("begin");
    try {
      await db.query("set local role service_role");
      await db.query(`select set_config('request.jwt.claims','{"role":"service_role"}',true)`);
      await db.query(`insert into public.tenants (tenant_id, status) values ('probe-a','active')`);
      await db.query("set local role tenant_app");
      const claims = JSON.stringify({ role: "tenant_app", tenant_id: TENANT_PROBE_ID });
      await db.query("select set_config('request.jwt.claims',$1,true)", [claims]);
      const { rows } = await db.query("select tenant_id from public.tenants limit 1");
      expect(rows).toEqual([]);
    } finally {
      await db.query("rollback");
    }
  });
});
