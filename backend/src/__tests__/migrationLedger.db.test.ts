import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseMigrationCommand, runMigrationCommand } from "../scripts/migrationLedger";

const databaseUrl = process.env.MIKE_MIGRATION_TEST_DATABASE_URL;
const log = { info: () => {}, warn: () => {}, error: () => {} };

// The shell harness starts a disposable PostgreSQL container. Never allow this
// reset-based fixture suite to run against an ordinary developer/customer DB.
describe.skipIf(!databaseUrl)("migration runner disposable PostgreSQL guarantees", () => {
  let client: Client;
  let directory: string;
  const connect = () => new Client({ connectionString: databaseUrl });
  const up = () => runMigrationCommand(client, { kind: "up" }, directory, log);
  const status = () => runMigrationCommand(client, { kind: "status" }, directory, log);
  const history = async () => (await client.query("select name, checksum from public.pgmigrations order by name")).rows;
  const add = (filename: string, sql: string) => writeFile(path.join(directory, filename), sql);

  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.startsWith("/mike_migration_test_")) {
      throw new Error("Migration DB tests require a disposable mike_migration_test_ database");
    }
    client = connect();
    await client.connect();
    await client.query(`do $$ begin
      if not exists(select 1 from pg_roles where rolname='web_anon') then create role web_anon; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
    end $$;`);
  });
  beforeEach(async () => {
    await client.query("drop schema public cascade; create schema public");
    directory = await mkdtemp(path.join(tmpdir(), "mike-migration-db-"));
    await add("0000_initial.sql", "create table public.probe(id integer primary key);");
    await add("0109_migration_history_checksums.sql",
      await readFile(path.resolve(__dirname, "../../migrations/0109_migration_history_checksums.sql"), "utf8"));
    await add("UPSTREAM_SYNC_LOG.md", "this must never execute");
  });
  afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
  afterAll(async () => { await client?.end(); });

  it("reports a fresh database without creating history, then applies each file once", async () => {
    expect(await status()).toBe(2);
    expect((await client.query("select to_regclass('public.pgmigrations') as relation")).rows[0].relation).toBeNull();
    expect(await up()).toBe(0);
    expect(await status()).toBe(0);
    expect(await history()).toHaveLength(2);
    expect((await history()).every((row) => /^[a-f0-9]{64}$/.test(row.checksum))).toBe(true);
    await client.query("insert into probe values (1)");
    expect(await up()).toBe(0);
    expect((await client.query("select * from probe")).rows).toEqual([{ id: 1 }]);
  });

  it("upgrades old history without certifying old bytes or baselining new files", async () => {
    await rm(path.join(directory, "0109_migration_history_checksums.sql"));
    expect(await up()).toBe(0); // old runner layout, before checksum column
    await add("0109_migration_history_checksums.sql",
      await readFile(path.resolve(__dirname, "../../migrations/0109_migration_history_checksums.sql"), "utf8"));
    await add("0110_new.sql", "alter table probe add column upgraded boolean default true;");
    expect(await up()).toBe(0);
    const rows = await history();
    expect(rows[0].checksum).toBeNull();
    expect(rows.slice(1).every((row) => row.checksum?.length === 64)).toBe(true);
    expect((await client.query("select column_name from information_schema.columns where table_name='probe' order by column_name")).rows)
      .toEqual([{ column_name: "id" }, { column_name: "upgraded" }]);
    expect(await status()).toBe(0);
  });

  it("stops on failure, leaving the failed and later files pending", async () => {
    await up();
    await add("0110_broken.sql", "select * from public.intentionally_absent;");
    await add("0111_later.sql", "create table must_not_exist(id int);");
    await expect(up()).rejects.toThrow();
    expect(await history()).toHaveLength(2);
    expect((await client.query("select to_regclass('public.must_not_exist') as relation")).rows[0].relation).toBeNull();
    expect(await status()).toBe(2);
  });

  it("refuses changed or renamed recorded SQL instead of replaying it", async () => {
    await up();
    await add("0000_initial.sql", "create table probe(id text);");
    expect(await status()).toBe(1);
    await expect(up()).rejects.toThrow(/history differs/);
    await rm(path.join(directory, "0000_initial.sql"));
    expect(await status()).toBe(1);
    await expect(up()).rejects.toThrow(/history differs/);
  });

  it("requires explicit bounded baseline/mark and leaves manual rows unverified", async () => {
    await client.query("create table public.probe(id integer primary key)");
    await runMigrationCommand(client, parseMigrationCommand(["baseline", "0000_initial.sql", "--confirm-applied"]), directory, log);
    expect((await client.query("select name from pgmigrations")).rows).toEqual([{ name: "0000_initial" }]);
    expect(await status()).toBe(2);
    await up();
    expect((await history())[0].checksum).toBeNull();
    await add("0110_manual.sql", "alter table probe add column manual boolean;");
    await add("0111_future.sql", "create table future(id int);");
    await expect(runMigrationCommand(client,
      parseMigrationCommand(["mark", "0111_future.sql", "--confirm-applied"]), directory, log)).rejects.toThrow(/next pending/);
    await client.query("alter table probe add column manual boolean");
    await runMigrationCommand(client,
      parseMigrationCommand(["mark", "0110_manual.sql", "--confirm-applied"]), directory, log);
    expect((await history()).at(-1)?.checksum).toBeNull();
    expect(await status()).toBe(2); // future is still pending
  });

  it("shares the lock with the old CLI and removes app-role write grants", async () => {
    const other = connect();
    await other.connect();
    try {
      await other.query("select pg_advisory_lock(7241865325823964)");
      await expect(up()).rejects.toThrow(/already running/);
    } finally { await other.end(); }
    await up();
    const privileges = (await client.query(`select
      has_table_privilege('web_anon','public.pgmigrations','SELECT') as anonymous_read,
      has_table_privilege('authenticated','public.pgmigrations','INSERT') as authenticated_write,
      has_table_privilege('service_role','public.pgmigrations','UPDATE') as service_write,
      has_table_privilege('service_role','public.pgmigrations','SELECT') as service_read,
      has_sequence_privilege('service_role','public.pgmigrations_id_seq','USAGE') as sequence_write`)).rows[0];
    expect(privileges).toEqual({
      anonymous_read: false, authenticated_write: false, service_write: false,
      service_read: true, sequence_write: false,
    });
  });
});
