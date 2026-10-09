// The actual desktop bootstrap must converge from an existing numbered Dev
// installation and from an empty database without schema.sql or a second ledger.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { Client } = require("pg");
const schema = require("./schema");
const BASELINE_REF = "795f5cac7f53b6ccfb457eb4bdc018d065351d61";
const REPO = path.resolve(__dirname, "../../..");
const BACKEND = path.join(REPO, "backend");
const PG_BIN = path.join(__dirname, "../../local-stack/bin/pg/bin");
const helper = path.join(BACKEND, "dist/scripts/migrationLedger.js");
const available = fs.existsSync(path.join(PG_BIN, "postgres")) && fs.existsSync(helper);
const required = process.env.MIKE_REQUIRE_LOCAL_STACK === "1";
if (required) assert.ok(available, "Native Postgres and built canonical migration helper are required");
const skip = available ? false : "native Postgres or built backend unavailable";
const git = (...args) => {
  const result = spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// A throwaway cluster from the same binaries the app bundles. Trust auth on
// loopback: this is a test database that lives for a few seconds.
async function startCluster() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mike-upgrade-test-"));
  const pgdata = path.join(dir, "pgdata");
  const res = spawnSync(path.join(PG_BIN, "initdb"),
    ["-D", pgdata, "-U", "postgres", "-E", "UTF8", "--auth=trust"], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`initdb failed: ${res.stderr}`);
  const port = await freePort();
  const proc = spawn(path.join(PG_BIN, "postgres"),
    ["-D", pgdata, "-p", String(port), "-c", "listen_addresses=127.0.0.1", "-k", "", "-c", "fsync=off"],
    { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => { stderr += d; });
  const withPg = async (fn) => {
    const client = new Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres" });
    await client.connect();
    try { return await fn(client); } finally { await client.end(); }
  };
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`postgres exited: ${stderr}`);
    try { await withPg((c) => c.query("select 1")); break; } catch { /* booting */ }
    if (Date.now() > deadline) throw new Error(`postgres never came up: ${stderr}`);
    await sleep(200);
  }
  const stop = async () => {
    proc.kill("SIGINT");
    await new Promise((r) => { proc.on("exit", r); setTimeout(r, 10_000); });
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { withPg, stop };
}


async function reset(withPg) {
  await schema.pgExec(withPg, "drop schema if exists public cascade; create schema public", "reset");
}
async function fingerprint(withPg) {
  const result = await withPg((client) => client.query(`
    select c.relname || '.' || a.attname || ':' || format_type(a.atttypid,a.atttypmod) ||
      ':' || a.attnotnull || ':' || coalesce(pg_get_expr(d.adbin,d.adrelid),'') as shape
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
    where n.nspname='public' and c.relkind in ('r','v') order by shape`));
  return result.rows;
}
test("numbered desktop upgrades converge with fresh installs and never replay applied files", { skip }, async () => {
  const cluster = await startCluster();
  const baseline = fs.mkdtempSync(path.join(os.tmpdir(), "mike-numbered-baseline-"));
  try {
    const { withPg } = cluster;
    fs.mkdirSync(path.join(baseline, "migrations"));
    fs.mkdirSync(path.join(baseline, "dist/scripts"), { recursive: true });
    // Use the production helper, not a second implementation of its history.
    fs.writeFileSync(path.join(baseline, "dist/scripts/migrationLedger.js"),
      `module.exports = require(${JSON.stringify(helper)});`);
    const oldFiles = git("ls-tree", "--name-only", BASELINE_REF, "backend/migrations/")
      .trim().split("\n").filter((file) => /\/\d{4}_[a-z0-9_]+\.sql$/i.test(file));
    assert.ok(oldFiles.length > 0);
    for (const file of oldFiles) {
      fs.writeFileSync(path.join(baseline, "migrations", path.basename(file)), git("show", `${BASELINE_REF}:${file}`));
    }
    await schema.bootstrapRoles(withPg, "test-password");
    await schema.applySchema(withPg, baseline);
    await schema.applySchema(withPg, BACKEND);
    const names = await withPg(async (client) => (await client.query("select name from public.pgmigrations order by name")).rows.map((row) => row.name));
    assert.deepEqual(names, schema.listMigrations(BACKEND).map((file) => file.slice(0, -4)));
    const oldChecksums = await withPg(async (client) => (await client.query("select count(*)::int as count from pgmigrations where checksum is null")).rows[0].count);
    assert.equal(oldChecksums, oldFiles.length, "older history remains explicitly unverified");
    const shape = await fingerprint(withPg);
    await schema.applySchema(withPg, BACKEND);
    assert.deepEqual(await fingerprint(withPg), shape, "returning launch does not replay or change schema");
    assert.ok(shape.length > 100);
    const protection = await withPg(async (client) => (await client.query(`select
      has_table_privilege('service_role','pgmigrations','SELECT') as read,
      has_table_privilege('service_role','pgmigrations','UPDATE') as write,
      to_regclass('public.schema_migrations') is null as no_secondary,
      to_regclass('public.mike_schema_migrations') is null as no_desktop,
      to_regclass('auth.users') is null as no_auth_schema`)).rows[0]);
    assert.deepEqual(protection, { read: true, write: false, no_secondary: true, no_desktop: true, no_auth_schema: true });
    await reset(withPg);
    await schema.applySchema(withPg, BACKEND);
    assert.deepEqual(await fingerprint(withPg), shape, "fresh and upgraded numbered schemas converge");
  } finally {
    await cluster.stop();
    fs.rmSync(baseline, { recursive: true, force: true });
  }
});
