import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { runner } from "node-pg-migrate";
import type { ClientBase } from "pg";

// Upstream 49efc046: keep Dev's numbered pgmigrations history authoritative.
// This is node-pg-migrate 7.x's lock, shared with its CLI and older jobs.
const MIGRATION_LOCK_ID = "7241865325823964";
const FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/i;

export function migrationLockWaitSeconds(value = process.env.MIGRATE_LOCK_WAIT ?? "900"): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value) * 1000)) {
    throw new Error("MIGRATE_LOCK_WAIT must be a whole number of seconds");
  }
  return Number(value);
}

/** Unknown pooler ports cannot be inferred; operators must use a session connection. */
export function assertDirectMigrationConnection(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  const port = url.searchParams.get("port") || url.port;
  if (port === "6543" || url.searchParams.get("pool_mode") === "transaction" || url.searchParams.get("pgbouncer") === "true") {
    throw new Error("Migrations require a direct or session connection; transaction poolers (including port 6543) are unsupported");
  }
}

export function assertSupportedMigrationSql(sql: string, filename: string): void {
  // node-pg-migrate 7.x's SQL loader has no noTransaction annotation. Never
  // silently execute an opt-out file inside its native transaction wrapper.
  if (/^-- migrate:no-transaction\s*$/m.test(sql) || /\bconcurrently\b/i.test(sql)) {
    throw new Error(`${filename}: nontransactional SQL is unsupported by the current numbered SQL runner; use a separately approved migration mechanism`);
  }
}

async function acquireMigrationLock(client: ClientBase, waitSeconds: number, log: Pick<Console, "warn">): Promise<void> {
  const started = Date.now();
  let holder = "holder not visible";
  let reported = false;
  while (true) {
    const locked = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock($1::bigint) as acquired", [MIGRATION_LOCK_ID],
    );
    if (locked.rows[0]?.acquired) return;
    try {
      const result = await client.query<{ pid: number; application_name: string | null; backend_start: Date | null }>(
        `select l.pid, a.application_name, a.backend_start
         from pg_locks l left join pg_stat_activity a on a.pid = l.pid
         where l.locktype = 'advisory' and l.granted and l.objsubid = 1
           and l.database = (select oid from pg_database where datname = current_database())
           and l.classid::bigint = ($1::bigint >> 32)
           and l.objid::bigint = ($1::bigint & 4294967295)`, [MIGRATION_LOCK_ID],
      );
      holder = result.rows.map(row => `pid ${row.pid}, ${row.application_name || "unnamed"}, connected ${row.backend_start?.toISOString() || "unknown"}`).join("; ") || "holder not visible";
    } catch { /* Diagnostics are best effort without pg_read_all_stats. */ }
    if (!reported) {
      log.warn(`[migrate] migration lock held by ${holder}; waiting up to ${waitSeconds}s`);
      reported = true;
    }
    const remaining = waitSeconds * 1000 - (Date.now() - started);
    if (remaining <= 0) throw new Error(`Another migration is already running; gave up after ${waitSeconds}s waiting for the migration lock (${holder})`);
    // Never hold a blocking advisory-lock query's snapshot while waiting.
    await delay(Math.min(2000, remaining));
  }
}

async function hasExistingSchema(client: ClientBase): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `select exists (
       select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r','p','v','m','f','S')
         and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
       union all
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
       union all
       select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'public' and t.typtype in ('e','d')
         and not exists (select 1 from pg_depend d where d.classid = 'pg_type'::regclass and d.objid = t.oid and d.deptype = 'e')
     ) as present`,
  );
  return Boolean(result.rows[0]?.present);
}

export type MigrationCommand =
  | { kind: "status" | "up" }
  | { kind: "baseline" | "mark"; filename: string };

export function parseMigrationCommand(args: string[]): MigrationCommand {
  const [kind = "up", filename, confirmation, ...extra] = args;
  if ((kind === "up" || kind === "status") && args.length <= 1) return { kind };
  if ((kind === "baseline" || kind === "mark") && filename &&
      FILE_PATTERN.test(filename) && confirmation === "--confirm-applied" && !extra.length) {
    return { kind, filename };
  }
  throw new Error("Usage: migrate [up|status|baseline FILE --confirm-applied|mark FILE --confirm-applied]");
}

export type MigrationFile = { filename: string; name: string; checksum: string };
export type AppliedMigration = { name: string; checksum: string | null };

export async function migrationFiles(directory: string): Promise<MigrationFile[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const slots = new Set<string>();
  return Promise.all(names.map(async (filename) => {
    const slot = filename.slice(0, 4);
    if (!FILE_PATTERN.test(filename) || slots.has(slot)) {
      throw new Error(`Invalid or duplicate numbered migration: ${filename}`);
    }
    slots.add(slot);
    // Git checkouts on Windows can use CRLF. Hash the same UTF-8 SQL on every
    // host; whitespace/content changes beyond line-ending conversion still count.
    const sql = (await readFile(path.join(directory, filename), "utf8")).replace(/\r\n/g, "\n");
    return {
      filename, name: filename.slice(0, -4),
      checksum: createHash("sha256").update(sql).digest("hex"),
    };
  }));
}

export function compareMigrationHistory(files: MigrationFile[], applied: AppliedMigration[]) {
  const byName = new Map(files.map((file) => [file.name, file]));
  const recorded = new Set(applied.map((row) => row.name));
  const pending = files.filter((file) => !recorded.has(file.name));
  return {
    pending,
    changed: applied.filter((row) => row.checksum && byName.has(row.name) &&
      row.checksum !== byName.get(row.name)!.checksum).map((row) => row.name),
    missing: applied.filter((row) => !byName.has(row.name)).map((row) => row.name),
    unverified: applied.filter((row) => !row.checksum).map((row) => row.name),
    outOfOrder: pending.filter((file) => applied.some((row) => row.name > file.name)).map((file) => file.name),
  };
}

async function readHistory(client: ClientBase): Promise<AppliedMigration[]> {
  const existence = await client.query<{ present: boolean }>(
    "select to_regclass('public.pgmigrations') is not null as present",
  );
  if (!existence.rows[0]?.present) return [];
  const columns = await client.query<{ present: boolean }>(
    "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'pgmigrations' and column_name = 'checksum') as present",
  );
  const checksum = columns.rows[0]?.present ? "checksum" : "null::text as checksum";
  return (await client.query<AppliedMigration>(
    `select name, ${checksum} from public.pgmigrations order by run_on, id`,
  )).rows;
}

/** The caller owns a connected direct PostgreSQL session, never a transaction pooler. */
export async function runMigrationCommand(
  client: ClientBase,
  command: MigrationCommand,
  directory = "migrations",
  log: Pick<Console, "info" | "warn" | "error"> = console,
  options: { lockWaitSeconds?: number } = {},
): Promise<number> {
  const connection = (client as ClientBase & { connectionParameters?: { port?: number } }).connectionParameters;
  if (connection?.port === 6543) throw new Error("Migrations require a direct or session connection; port 6543 transaction poolers are unsupported");
  const waitSeconds = migrationLockWaitSeconds(String(options.lockWaitSeconds ?? migrationLockWaitSeconds()));
  await acquireMigrationLock(client, waitSeconds, log);
  try {
    const files = await migrationFiles(directory);
    const existence = await client.query<{ present: boolean }>("select to_regclass('public.pgmigrations') is not null as present");
    const unknownHistory = !existence.rows[0]?.present && await hasExistingSchema(client);
    if (unknownHistory && command.kind !== "baseline") {
      throw new Error("Existing public schema has no pgmigrations history; independently verify the last applied filename and use baseline FILE --confirm-applied before upgrading");
    }
    const history = await readHistory(client);
    const state = compareMigrationHistory(files, history);
    for (const name of state.changed) log.warn(`[migrate] changed since applied: ${name}`);
    for (const name of state.missing) log.warn(`[migrate] recorded file is missing or renamed: ${name}`);
    for (const name of state.outOfOrder) log.warn(`[migrate] pending file precedes applied history: ${name}`);
    if (state.unverified.length) log.warn(
      `[migrate] ${state.unverified.length} recorded migration(s) have no verified checksum (older runner or explicitly recorded without execution)`,
    );
    if (command.kind === "status") {
      log.info(`${history.length} recorded, ${state.pending.length} pending, ${state.unverified.length} unverified`);
      for (const file of state.pending) log.info(`  pending: ${file.filename}`);
      if (state.changed.length || state.missing.length || state.outOfOrder.length) return 1;
      return state.pending.length ? 2 : 0;
    }
    // Do not let an upgrade silently replay a renamed file or accept changed
    // history. Restore shipped files and use a forward migration to correct SQL.
    if (state.changed.length || state.missing.length || state.outOfOrder.length) {
      throw new Error("Migration history differs from this checkout; inspect status before upgrading");
    }
    let selected = state.pending;
    if (command.kind === "baseline" || command.kind === "mark") {
      const target = files.find((file) => file.filename === command.filename);
      if (!target) throw new Error(`No migration named ${command.filename}`);
      if (command.kind === "mark" && state.pending[0]?.name !== target.name) {
        throw new Error("mark must name the next pending migration, preserving numbered history");
      }
      selected = command.kind === "mark" ? [target] : state.pending.filter((file) => file.name <= target.name);
    }
    if (!selected.length) { log.info("Up to date."); return 0; }


    // Upstream divergence (sync-log: a178e85a): keep the numbered history and
    // native per-file SQL/history transaction. Shipped own-BEGIN/COMMIT SQL
    // remains unchanged and cannot be called atomic.
    const unstamped: MigrationFile[] = [];
    for (const file of selected) {
      const sql = await readFile(path.join(directory, file.filename), "utf8");
      if (command.kind === "up") {
        assertSupportedMigrationSql(sql, file.filename);
        if (/^\s*(begin|commit|rollback|abort|start\s+transaction)(\s+[^;]*)?;/im.test(sql)) {
          log.warn("[migrate] " + file.filename + ": historical transaction control; file/history atomicity is not guaranteed");
        }
      }
      try {
        const executed = await runner({
          dbClient: client, dir: directory, file: file.name,
          migrationsSchema: "public", migrationsTable: "pgmigrations",
          direction: "up", count: 1, checkOrder: true, singleTransaction: false,
          // The outer session lock covers checks, every file and checksums.
          noLock: true, fake: command.kind !== "up",
          ignorePattern: "(?![0-9]{4}_[a-zA-Z0-9_]+\\.sql$).*", logger: log,
        });
        if (command.kind !== "up") continue;
        if (executed.length) unstamped.push(file);
        // A crash here leaves an applied row unverified, never pending.
        const currentSql = (await readFile(path.join(directory, file.filename), "utf8")).replace(/\r\n/g, "\n");
        if (createHash("sha256").update(currentSql).digest("hex") !== file.checksum) {
          throw new Error("Migration file changed while upgrading; applied history remains recorded but checksum is unverified");
        }
        const column = await client.query<{ present: boolean }>(
          "select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'pgmigrations' and column_name = 'checksum') as present",
        );
        if (column.rows[0]?.present) {
          for (const applied of unstamped) {
            const current = (await readFile(path.join(directory, applied.filename), "utf8")).replace(/\r\n/g, "\n");
            if (createHash("sha256").update(current).digest("hex") !== applied.checksum) {
              throw new Error("Migration file changed while upgrading; applied history remains recorded but checksum is unverified");
            }
            await client.query("update public.pgmigrations set checksum = $1 where name = $2 and checksum is null", [applied.checksum, applied.name]);
          }
          unstamped.length = 0;
        }
      } catch (error) {
        // Native per-file mode leaves a failed transaction for its caller.
        await client.query("rollback");
        throw error;
      } finally {
        // DISCARD ALL would release the session lock, so restore only settings
        // and transient state before the next file or caller uses the session.
        await client.query("reset session authorization; reset role; reset all; discard temp; deallocate all; unlisten *");
      }
    }
    if (command.kind !== "up") log.warn("[migrate] explicitly recorded " + selected.length + " migration(s) WITHOUT running SQL; checksums remain unverified");
    return 0;
  } finally {
    await client.query("select pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_ID]);
  }
}
