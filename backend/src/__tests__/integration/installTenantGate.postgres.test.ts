// The install tenant gate against the real numbered migrations: what it predicts
// must be what 0176 then records, and a refusal must leave the database unchanged.
//
// Opt in with a superuser URL to a DISPOSABLE PostgreSQL 16 server:
//
//   docker run -d --name mike-rls-test -e POSTGRES_PASSWORD=pw -p 55441:5432 postgres:16
//   $env:MIKE_TENANT_RLS_TEST_ADMIN_URL = "postgres://postgres:pw@localhost:55441/postgres"
//   npx vitest run src/__tests__/integration/installTenantGate.postgres.test.ts --testTimeout=120000
//   docker rm -f mike-rls-test
//
// It creates the same cluster roles as uploadClaimsAsTenant.postgres.test.ts and
// its own mike_gate_test_* databases, and never touches another database.
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrationCommand } from "../../scripts/migrationLedger";
import { assertInstallTenantGate } from "../../scripts/installTenantGate";
import { configureStampDeployment } from "../../lib/stampDeployment";

const adminUrl = process.env.MIKE_TENANT_RLS_TEST_ADMIN_URL;
const quiet = { info: () => {}, warn: () => {}, error: console.error };
const MIGRATOR = "mike_rls_test_migrator";
const CONFIGURED = "11111111-2222-4333-8444-555555555555";

describe.skipIf(!adminUrl)("install tenant gate on real migrations", () => {
  const stamp = `${process.pid}_${Date.now()}`;
  const template = `mike_gate_test_${stamp}_t`;
  const password = randomBytes(12).toString("hex");
  let admin: Client;
  const directories: Record<"before" | "through" | "all", string> = { before: "", through: "", all: "" };
  const open: Client[] = [];
  let counter = 0;

  const urlFor = (database: string) => {
    const url = new URL(adminUrl!);
    url.username = MIGRATOR;
    url.password = password;
    url.pathname = `/${database}`;
    return url.toString();
  };

  async function connect(database: string): Promise<Client> {
    const client = new Client({ connectionString: urlFor(database) });
    await client.connect();
    open.push(client);
    return client;
  }

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
    await admin.query(`create database ${template} owner ${MIGRATOR}`);

    const source = path.resolve(__dirname, "../../../migrations");
    const names = (await readdir(source)).filter((name) => name.endsWith(".sql"));
    for (const [key, last] of [["before", "0175"], ["through", "0176"], ["all", "9999"]] as const) {
      const directory = await mkdtemp(path.join(tmpdir(), "mike-gate-test-"));
      for (const name of names) {
        if (name.slice(0, 4) <= last) await copyFile(path.join(source, name), path.join(directory, name));
      }
      directories[key] = directory;
    }
    const db = new Client({ connectionString: urlFor(template) });
    await db.connect();
    await expect(runMigrationCommand(db, { kind: "up" }, directories.before, quiet)).resolves.toBe(0);
    await db.end();
  }, 600_000);

  afterEach(async () => {
    while (open.length) await open.pop()!.end().catch(() => {});
  });

  afterAll(async () => {
    for (const directory of Object.values(directories)) {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
    if (admin) {
      const names = await admin.query<{ datname: string }>(
        "select datname from pg_database where datname like $1",
        [`mike_gate_test_${stamp}%`],
      );
      for (const row of names.rows) await admin.query(`drop database if exists ${row.datname} with (force)`).catch(() => {});
      await admin.end().catch(() => {});
    }
  }, 120_000);

  /** A database at the last release before 0176. */
  async function databaseBefore0176(): Promise<Client> {
    counter += 1;
    const name = `mike_gate_test_${stamp}_${counter}`;
    await admin.query(`create database ${name} template ${template} owner ${MIGRATOR}`);
    return connect(name);
  }

  function upgrade(db: Client, configuredTenant: string | null, directory = directories.through) {
    const readConfiguration = vi.fn(async () => ({
      mode: "single" as const,
      provider: "entra",
      fallbackTenantId: configuredTenant,
    }));
    const run = runMigrationCommand(db, { kind: "up" }, directory, quiet, {
      beforeApply: (pending) => assertInstallTenantGate(db, pending, readConfiguration),
    });
    return { run, readConfiguration };
  }

  const installTenant = async (db: Client) =>
    (await db.query<{ fallback_tenant_id: string | null }>("select fallback_tenant_id from app.install_tenancy")).rows[0]
      .fallback_tenant_id;
  const applied = async (db: Client) =>
    (await db.query<{ n: number }>("select count(*)::int as n from public.pgmigrations where name like '0176%'")).rows[0].n;
  const seedData = (db: Client) =>
    db.query("insert into public.user_profiles (user_id, display_name) values (gen_random_uuid(), 'Someone')");
  const seedTenant = (db: Client, id: string, status: string, age: string) =>
    db.query("insert into public.tenants (tenant_id, status, created_at) values ($1, $2, now() - $3::interval)", [id, status, age]);

  it("refuses a tenants row that differs, leaving the database at 0175", async () => {
    const db = await databaseBefore0176();
    await seedTenant(db, "other-tenant", "active", "1 day");
    await seedData(db);

    await expect(upgrade(db, CONFIGURED).run).rejects.toThrow(/No migration has run.*other-tenant.*11111111/s);

    expect(await applied(db)).toBe(0);
    const metadata = await db.query("select to_regclass('app.install_tenancy') as t");
    expect(metadata.rows[0].t).toBeNull();
    const column = await db.query(
      "select 1 from information_schema.columns where table_name = 'user_profiles' and column_name = 'tenant_id'",
    );
    expect(column.rowCount).toBe(0);
  });

  it("refuses default when data has no tenants row on an install with another tenant", async () => {
    const db = await databaseBefore0176();
    await seedData(db);
    await expect(upgrade(db, CONFIGURED).run).rejects.toThrow(/public\.tenants is empty/);
    expect(await applied(db)).toBe(0);
  });

  it("passes the configured tenant, and 0176 records exactly that", async () => {
    const db = await databaseBefore0176();
    await seedTenant(db, CONFIGURED, "active", "1 day");
    await seedData(db);
    await expect(upgrade(db, CONFIGURED).run).resolves.toBe(0);
    expect(await installTenant(db)).toBe(CONFIGURED);
  });

  it("passes default where default is configured, and 0176 records exactly that", async () => {
    const db = await databaseBefore0176();
    await seedData(db);
    await expect(upgrade(db, "default").run).resolves.toBe(0);
    expect(await installTenant(db)).toBe("default");
  });

  it("predicts 0176's ordering: active first, then oldest", async () => {
    const db = await databaseBefore0176();
    await seedTenant(db, "older-suspended", "suspended", "9 days");
    await seedTenant(db, CONFIGURED, "active", "2 days");
    await seedTenant(db, "newer-active", "active", "1 day");
    await expect(upgrade(db, CONFIGURED).run).resolves.toBe(0);
    expect(await installTenant(db)).toBe(CONFIGURED);
  });

  it("the documented repair lets a refused upgrade through", async () => {
    const db = await databaseBefore0176();
    await seedTenant(db, "other-tenant", "active", "9 days");
    await seedData(db);
    await expect(upgrade(db, CONFIGURED).run).rejects.toThrow(/No migration has run/);

    await db.query(
      `insert into public.tenants (tenant_id, status) values ($1, 'active')
       on conflict (tenant_id) do update set status = 'active'`,
      [CONFIGURED],
    );
    await db.query("update public.tenants set status = 'suspended' where tenant_id <> $1", [CONFIGURED]);

    await expect(upgrade(db, CONFIGURED).run).resolves.toBe(0);
    expect(await installTenant(db)).toBe(CONFIGURED);
  });

  it("does not fire on a database before 0176 with no tenants and no user data", async () => {
    const db = await databaseBefore0176();
    const { run, readConfiguration } = upgrade(db, CONFIGURED);
    await expect(run).resolves.toBe(0);
    expect(readConfiguration).not.toHaveBeenCalled();
    expect(await installTenant(db)).toBeNull();
  });

  it("does not fire on an empty database replaying the whole chain", async () => {
    counter += 1;
    const name = `mike_gate_test_${stamp}_${counter}`;
    await admin.query(`create database ${name} owner ${MIGRATOR}`);
    const db = await connect(name);
    const { run, readConfiguration } = upgrade(db, CONFIGURED);
    await expect(run).resolves.toBe(0);
    expect(readConfiguration).not.toHaveBeenCalled();
  }, 300_000);

  it("does not fire once the database is past 0176", async () => {
    const db = await databaseBefore0176();
    await seedTenant(db, "other-tenant", "active", "1 day");
    await seedData(db);
    const first = await runMigrationCommand(db, { kind: "up" }, directories.through, quiet);
    expect(first).toBe(0);
    expect(await installTenant(db)).toBe("other-tenant");

    const { run, readConfiguration } = upgrade(db, CONFIGURED, directories.all);
    await expect(run).resolves.toBe(0);
    expect(readConfiguration).not.toHaveBeenCalled();

    // Why the gate exists: without it, deployment setup clears the pick (no row
    // for the configured tenant), so the startup probe passes, and the data
    // stays with a tenant nobody signs in as.
    await configureStampDeployment(db, {
      mode: "single",
      provider: "entra",
      localDevelopment: false,
      fallbackTenantId: CONFIGURED,
    });
    expect(await installTenant(db)).toBeNull();
    await db.query("begin");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: "other-tenant" })]);
    const owners = await db.query<{ tenant_id: string }>("select tenant_id from public.user_profiles");
    await db.query("rollback");
    expect(owners.rows).toEqual([{ tenant_id: "other-tenant" }]);
  }, 300_000);
});
