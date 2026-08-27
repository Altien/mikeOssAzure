import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type SqlValue = string | number | null | Buffer;
type Row = Record<string, unknown>;
type Result<T = unknown> = { data: T | null; error: Error | null };

type Statement = {
  run(...values: unknown[]): unknown;
  get(...values: unknown[]): Row | undefined;
  all(...values: unknown[]): Row[];
};

type Database = {
  exec(sql: string): void;
  prepare(sql: string): Statement;
};

type DatabaseSyncConstructor = new (filename: string) => Database;

function loadDatabaseSync(): DatabaseSyncConstructor {
  try {
    // Load the optional native driver only when the SQLite provider is used.
    // This allows the upstream Supabase profile to keep running on Node 20.
    const sqlite = require("node:sqlite") as {
      DatabaseSync: DatabaseSyncConstructor;
    };
    return sqlite.DatabaseSync;
  } catch (error) {
    throw new Error(
      "The SQLite database provider requires a Node runtime with node:sqlite support (Node 22 or newer).",
      { cause: error },
    );
  }
}

let cachedDb: Database | undefined;

export function sqlitePath(): string {
  return (
    process.env.SQLITE_DB_PATH?.trim() ||
    path.join(process.cwd(), "data", "mike.sqlite")
  );
}

export function getSqliteDb(): Database {
  if (!cachedDb) {
    const dbPath = sqlitePath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const DatabaseSync = loadDatabaseSync();
    cachedDb = new DatabaseSync(dbPath) as Database;
    cachedDb.exec(`
      pragma journal_mode = WAL;
      create table if not exists local_users (
        id text primary key,
        email text not null unique,
        password_hash text not null,
        password_salt text not null,
        created_at text not null default (datetime('now')),
        updated_at text not null default (datetime('now'))
      );
      create table if not exists local_sessions (
        token_hash text primary key,
        user_id text not null,
        expires_at text not null,
        created_at text not null default (datetime('now'))
      );
      create table if not exists gmail_connections (
        user_id text primary key,
        email text not null,
        encrypted_refresh_token text not null,
        iv text not null,
        auth_tag text not null,
        scopes text not null default '[]',
        created_at text not null,
        updated_at text not null
      );
      create table if not exists gmail_oauth_states (
        id text primary key,
        user_id text not null,
        redirect_uri text not null,
        expires_at text not null,
        created_at text not null
      );
      create index if not exists idx_gmail_oauth_states_expiry
        on gmail_oauth_states(expires_at);
      create table if not exists legal_monitors (
        id text primary key,
        user_id text not null,
        name text not null,
        topic text not null,
        jurisdiction text not null,
        source_types text not null,
        connector_id text not null,
        connector_config text not null default '{"mode":"agent"}',
        model text not null,
        interval_hours integer not null,
        lookback_days integer not null default 14,
        max_items_per_run integer not null default 50,
        alert_email text,
        email_enabled integer not null default 0,
        enabled integer not null default 1,
        next_run_at text,
        last_run_at text,
        last_status text,
        last_error text,
        created_at text not null,
        updated_at text not null
      );
      create index if not exists idx_legal_monitors_user_updated
        on legal_monitors(user_id, updated_at desc);
      create index if not exists idx_legal_monitors_due
        on legal_monitors(enabled, next_run_at);
      create table if not exists legal_monitor_documents (
        id text primary key,
        monitor_id text not null,
        user_id text not null,
        document_id text not null,
        position integer not null default 0,
        created_at text not null,
        unique(monitor_id, document_id)
      );
      create index if not exists idx_legal_monitor_documents_monitor
        on legal_monitor_documents(monitor_id, position);
      create index if not exists idx_legal_monitor_documents_document
        on legal_monitor_documents(document_id);
      create index if not exists idx_legal_monitor_documents_user
        on legal_monitor_documents(user_id);
      create table if not exists legal_monitor_runs (
        id text primary key,
        monitor_id text not null,
        user_id text not null,
        status text not null,
        summary text,
        report text,
        developments text,
        has_material_updates integer not null default 0,
        tool_calls integer not null default 0,
        source_items_count integer not null default 0,
        source_errors text,
        email_status text not null default 'not_requested',
        email_error text,
        error text,
        started_at text not null,
        completed_at text,
        created_at text not null,
        updated_at text not null
      );
      create index if not exists idx_legal_monitor_runs_monitor_started
        on legal_monitor_runs(monitor_id, started_at desc);
      create index if not exists idx_legal_monitor_runs_user_started
        on legal_monitor_runs(user_id, started_at desc);
      create table if not exists legal_monitor_sources (
        id text primary key,
        monitor_id text not null,
        user_id text not null,
        kind text not null,
        name text not null,
        url text not null,
        category text,
        enabled integer not null default 1,
        etag text,
        last_modified text,
        last_checked_at text,
        last_success_at text,
        last_error text,
        item_count integer not null default 0,
        created_at text not null,
        updated_at text not null,
        unique(monitor_id, kind, url)
      );
      create index if not exists idx_legal_monitor_sources_monitor
        on legal_monitor_sources(monitor_id, created_at);
      create index if not exists idx_legal_monitor_sources_user
        on legal_monitor_sources(user_id, updated_at desc);
      create table if not exists legal_monitor_source_items (
        id text primary key,
        monitor_id text not null,
        source_id text not null,
        user_id text not null,
        external_id text not null,
        canonical_url text,
        title text not null,
        published_at text,
        summary text,
        content text,
        content_hash text not null,
        first_seen_at text not null,
        last_seen_at text not null,
        processed_at text,
        created_at text not null,
        updated_at text not null,
        unique(source_id, external_id)
      );
      create index if not exists idx_legal_monitor_source_items_pending
        on legal_monitor_source_items(monitor_id, processed_at, first_seen_at);
      create index if not exists idx_legal_monitor_source_items_source
        on legal_monitor_source_items(source_id, published_at desc);
      create table if not exists legal_monitor_connector_items (
        id text primary key,
        monitor_id text not null,
        user_id text not null,
        connector_id text not null,
        tool_name text not null,
        external_id text not null,
        payload text not null,
        first_seen_at text not null,
        last_seen_at text not null,
        processed_at text,
        created_at text not null,
        updated_at text not null,
        unique(monitor_id, connector_id, tool_name, external_id)
      );
      create index if not exists idx_legal_monitor_connector_items_pending
        on legal_monitor_connector_items(monitor_id, processed_at, first_seen_at);
      create index if not exists idx_legal_monitor_connector_items_source
        on legal_monitor_connector_items(connector_id, tool_name, last_seen_at desc);
      create table if not exists saved_prompts (
        id text primary key,
        user_id text not null,
        name text not null,
        prompt text not null,
        description text,
        prompt_type text,
        categories text not null default '[]',
        practice_areas text not null default '[]',
        source_requirements text not null default '[]',
        created_at text not null,
        updated_at text not null
      );
      create index if not exists idx_saved_prompts_user_updated
        on saved_prompts(user_id, updated_at desc);
    `);
    const monitorColumns = new Set(cachedDb.prepare(`pragma table_info("legal_monitors")`).all().map((row) => String(row.name)));
    if (!monitorColumns.has("lookback_days")) cachedDb.exec(`alter table legal_monitors add column lookback_days integer not null default 14`);
    if (!monitorColumns.has("max_items_per_run")) cachedDb.exec(`alter table legal_monitors add column max_items_per_run integer not null default 50`);
    if (!monitorColumns.has("connector_config")) cachedDb.exec(`alter table legal_monitors add column connector_config text not null default '{"mode":"agent"}'`);
    const monitorRunColumns = new Set(cachedDb.prepare(`pragma table_info("legal_monitor_runs")`).all().map((row) => String(row.name)));
    if (!monitorRunColumns.has("source_items_count")) cachedDb.exec(`alter table legal_monitor_runs add column source_items_count integer not null default 0`);
    if (!monitorRunColumns.has("source_errors")) cachedDb.exec(`alter table legal_monitor_runs add column source_errors text`);
    const sessionColumns = cachedDb
      .prepare(`pragma table_info("local_sessions")`)
      .all()
      .map((row) => String(row.name));
    if (!sessionColumns.includes("mfa_verified")) {
      cachedDb.exec(
        `alter table local_sessions add column mfa_verified integer not null default 1`,
      );
    }
    ensureTable("user_profiles");
    ensureColumns("user_profiles", { feature_flags: "{}", dark_mode: false });
  }
  return cachedDb;
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQLite identifier: ${name}`);
  }
  return `"${name}"`;
}

function ensureTable(table: string): void {
  getSqliteDb().exec(`
    create table if not exists ${quoteIdent(table)} (
      id text primary key,
      created_at text,
      updated_at text
    )
  `);
}

function columnsFor(table: string): Set<string> {
  ensureTable(table);
  const rows = getSqliteDb().prepare(`pragma table_info(${quoteIdent(table)})`).all();
  return new Set(rows.map((row) => String(row.name)));
}

function ensureColumns(table: string, row: Row): void {
  const existing = columnsFor(table);
  for (const key of Object.keys(row)) {
    if (existing.has(key)) continue;
    getSqliteDb().exec(`alter table ${quoteIdent(table)} add column ${quoteIdent(key)} text`);
    existing.add(key);
  }
}

function encode(value: unknown): SqlValue {
  if (value === undefined) return null;
  if (value === null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function decode(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

function decodeColumn(key: string, value: unknown): unknown {
  const decoded = decode(value);
  if (
    (key === "mfa_on_login" ||
      key === "legal_research_us" ||
      key === "email_integration_enabled" ||
      key === "dark_mode" ||
      key === "document_upload" ||
      key === "enabled" ||
      key === "active") &&
    (decoded === 0 ||
      decoded === 1 ||
      decoded === "0" ||
      decoded === "1" ||
      decoded === "0.0" ||
      decoded === "1.0")
  ) {
    return decoded === 1 || decoded === "1" || decoded === "1.0";
  }
  return decoded;
}

function decodeRow(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, decodeColumn(key, value)]),
  );
}

function normalizeInsertRows(input: Row | Row[]): Row[] {
  const rows = Array.isArray(input) ? input : [input];
  const now = new Date().toISOString();
  return rows.map((row) => ({
    id: typeof row.id === "string" && row.id ? row.id : crypto.randomUUID(),
    created_at: row.created_at ?? now,
    updated_at: row.updated_at ?? now,
    ...row,
  }));
}

class SqliteQueryBuilder implements PromiseLike<Result<any>> {
  private mode: "select" | "insert" | "update" | "delete" = "select";
  private filters: string[] = [];
  private values: unknown[] = [];
  private orderBy: string | null = null;
  private rowLimit: number | null = null;
  private rowOffset: number | null = null;
  private wantsSingle = false;
  private wantsMaybeSingle = false;
  private selected = "*";
  private payload: unknown;
  private conflictColumns: string[] = ["id"];
  private ignoreDuplicates = false;

  constructor(private readonly table: string) {
    ensureTable(table);
  }

  select(columns = "*", _options?: { count?: string; head?: boolean }) {
    this.mode = this.mode === "insert" || this.mode === "update" ? this.mode : "select";
    this.selected = columns;
    return this;
  }

  insert(row: Row | Row[]) {
    this.mode = "insert";
    this.payload = row;
    return this;
  }

  update(row: Row) {
    this.mode = "update";
    this.payload = row;
    return this;
  }

  upsert(
    row: Row | Row[],
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ) {
    this.mode = "insert";
    this.payload = row;
    this.conflictColumns = options?.onConflict
      ?.split(",")
      .map((part) => part.trim())
      .filter(Boolean) || ["id"];
    this.ignoreDuplicates = options?.ignoreDuplicates === true;
    return this;
  }

  delete() {
    this.mode = "delete";
    return this;
  }

  eq(column: string, value: unknown) {
    ensureColumns(this.table, { [column]: null });
    this.filters.push(`${quoteIdent(column)} = ?`);
    this.values.push(encode(value));
    return this;
  }

  neq(column: string, value: unknown) {
    ensureColumns(this.table, { [column]: null });
    this.filters.push(`${quoteIdent(column)} != ?`);
    this.values.push(encode(value));
    return this;
  }

  gt(column: string, value: unknown) {
    ensureColumns(this.table, { [column]: null });
    this.filters.push(`${quoteIdent(column)} > ?`);
    this.values.push(encode(value));
    return this;
  }

  lt(column: string, value: unknown) {
    ensureColumns(this.table, { [column]: null });
    this.filters.push(`${quoteIdent(column)} < ?`);
    this.values.push(encode(value));
    return this;
  }

  in(column: string, values: unknown[]) {
    ensureColumns(this.table, { [column]: null });
    if (!values.length) {
      this.filters.push("1 = 0");
      return this;
    }
    this.filters.push(`${quoteIdent(column)} in (${values.map(() => "?").join(", ")})`);
    this.values.push(...values.map(encode));
    return this;
  }

  is(column: string, value: unknown) {
    ensureColumns(this.table, { [column]: null });
    this.filters.push(value === null ? `${quoteIdent(column)} is null` : `${quoteIdent(column)} is ?`);
    if (value !== null) this.values.push(encode(value));
    return this;
  }

  not(column: string, operator: string, value: unknown) {
    ensureColumns(this.table, { [column]: null });
    const normalized = operator.trim().toLowerCase();
    if (normalized === "is") {
      this.filters.push(
        value === null
          ? `${quoteIdent(column)} is not null`
          : `${quoteIdent(column)} is not ?`,
      );
      if (value !== null) this.values.push(encode(value));
      return this;
    }
    if (normalized === "eq") {
      this.filters.push(`${quoteIdent(column)} != ?`);
      this.values.push(encode(value));
      return this;
    }
    if (normalized === "in" && Array.isArray(value)) {
      if (!value.length) return this;
      this.filters.push(`${quoteIdent(column)} not in (${value.map(() => "?").join(", ")})`);
      this.values.push(...value.map(encode));
      return this;
    }
    throw new Error(`Unsupported SQLite not() operator: ${operator}`);
  }

  or(expression: string) {
    const terms = expression
      .split(",")
      .map((term) => term.trim())
      .filter(Boolean);
    const clauses: string[] = [];
    const clauseValues: unknown[] = [];
    for (const term of terms) {
      const match = term.match(/^([A-Za-z_][A-Za-z0-9_]*)\.(eq|neq|is|in)\.(.+)$/);
      if (!match) {
        throw new Error(`Unsupported SQLite or() term: ${term}`);
      }
      const [, column, operator, rawValue] = match;
      ensureColumns(this.table, { [column]: null });
      if (operator === "is") {
        if (rawValue === "null") clauses.push(`${quoteIdent(column)} is null`);
        else if (rawValue === "not.null")
          clauses.push(`${quoteIdent(column)} is not null`);
        else {
          clauses.push(`${quoteIdent(column)} is ?`);
          clauseValues.push(encode(rawValue));
        }
        continue;
      }
      if (operator === "in") {
        const values = rawValue.replace(/^\(|\)$/g, "").split(",").filter(Boolean);
        if (!values.length) {
          clauses.push("1 = 0");
          continue;
        }
        clauses.push(
          `${quoteIdent(column)} in (${values.map(() => "?").join(", ")})`,
        );
        clauseValues.push(...values.map(encode));
        continue;
      }
      clauses.push(
        operator === "eq"
          ? `${quoteIdent(column)} = ?`
          : `${quoteIdent(column)} != ?`,
      );
      clauseValues.push(encode(rawValue));
    }
    if (clauses.length) {
      this.filters.push(`(${clauses.join(" or ")})`);
      this.values.push(...clauseValues);
    }
    return this;
  }

  filter(column: string, operator: string, value: unknown) {
    ensureColumns(this.table, { [column]: null });
    if (operator === "cs") {
      const needle = Array.isArray(value)
        ? value[0]
        : typeof value === "string"
          ? safeJsonArrayFirst(value)
          : value;
      if (typeof needle === "string" && needle) {
        const escaped = needle
          .replace(/\\/g, "\\\\")
          .replace(/%/g, "\\%")
          .replace(/_/g, "\\_")
          .replace(/"/g, '\\"');
        this.filters.push(`${quoteIdent(column)} like ? escape '\\'`);
        this.values.push(`%"${escaped}"%`);
      }
      return this;
    }
    if (operator === "eq") return this.eq(column, value);
    return this;
  }

  order(
    column: string,
    options?: { ascending?: boolean; nullsFirst?: boolean; numeric?: boolean },
  ) {
    ensureColumns(this.table, { [column]: null });
    const direction = options?.ascending === false ? "desc" : "asc";
    this.orderBy = options?.numeric
      ? `cast(${quoteIdent(column)} as numeric) ${direction}`
      : `${quoteIdent(column)} ${direction}`;
    return this;
  }

  limit(count: number) {
    this.rowLimit = count;
    return this;
  }

  range(from: number, to: number) {
    this.rowOffset = from;
    this.rowLimit = Math.max(0, to - from + 1);
    return this;
  }

  single() {
    this.wantsSingle = true;
    return this.execute();
  }

  maybeSingle() {
    this.wantsMaybeSingle = true;
    return this.execute();
  }

  then<TResult1 = Result<any>, TResult2 = never>(
    onfulfilled?: ((value: Result<any>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private whereSql(): string {
    return this.filters.length ? ` where ${this.filters.join(" and ")}` : "";
  }

  private async execute(): Promise<Result<any>> {
    try {
      if (this.mode === "insert") return this.executeInsert();
      if (this.mode === "update") return this.executeUpdate();
      if (this.mode === "delete") return this.executeDelete();
      return this.executeSelect();
    } catch (error) {
      return { data: null, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  private selectedColumns(): string {
    if (this.selected.trim() === "*") return "*";
    const simple = this.selected
      .split(",")
      .map((part) => part.trim())
      .filter((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part));
    if (simple.length) {
      ensureColumns(
        this.table,
        Object.fromEntries(simple.map((column) => [column, null])),
      );
    }
    return simple.length ? simple.map(quoteIdent).join(", ") : "*";
  }

  private finishRows(rows: Row[]): Result<any> {
    const decoded = rows.map(decodeRow);
    if (this.wantsSingle) {
      if (decoded.length !== 1) return { data: null, error: new Error("Expected one row") };
      return { data: decoded[0], error: null };
    }
    if (this.wantsMaybeSingle) {
      return { data: decoded[0] ?? null, error: null };
    }
    return { data: decoded, error: null, count: decoded.length } as Result<any> & {
      count: number;
    };
  }

  private executeSelect(): Result<any> {
    let sql = `select ${this.selectedColumns()} from ${quoteIdent(this.table)}${this.whereSql()}`;
    if (this.orderBy) sql += ` order by ${this.orderBy}`;
    if (this.rowLimit !== null) sql += ` limit ${this.rowLimit}`;
    if (this.rowOffset !== null) sql += ` offset ${this.rowOffset}`;
    return this.finishRows(getSqliteDb().prepare(sql).all(...this.values));
  }

  private executeInsert(): Result<any> {
    const rows = normalizeInsertRows(this.payload as Row | Row[]);
    for (const row of rows) {
      // Supabase UUID primary keys commonly have a database default. Mirror
      // that behavior for dynamically-created local tables so inserts that
      // omit `id` do not accumulate nullable primary keys in SQLite.
      if (row.id === undefined && columnsFor(this.table).has("id")) {
        row.id = crypto.randomUUID();
      }
      ensureColumns(this.table, row);
      const existing = this.findConflictRow(row);
      if (existing) {
        if (this.ignoreDuplicates) continue;
        const updateRow = { ...row };
        delete updateRow.id;
        delete updateRow.created_at;
        ensureColumns(this.table, updateRow);
        const updateKeys = Object.keys(updateRow);
        if (updateKeys.length) {
          getSqliteDb()
            .prepare(
              `update ${quoteIdent(this.table)} set ${updateKeys
                .map((key) => `${quoteIdent(key)} = ?`)
                .join(", ")} where id = ?`,
            )
            .run(
              ...updateKeys.map((key) => encode(updateRow[key])),
              String(existing.id),
            );
        }
        continue;
      }
      const keys = Object.keys(row);
      const placeholders = keys.map(() => "?").join(", ");
      getSqliteDb()
        .prepare(
          `insert into ${quoteIdent(this.table)} (${keys.map(quoteIdent).join(", ")})
           values (${placeholders})`,
        )
        .run(...keys.map((key) => encode(row[key])));
    }
    return this.finishRows(rows);
  }

  private findConflictRow(row: Row): Row | null {
    const columns = this.conflictColumns.filter((column) => row[column] !== undefined);
    if (!columns.length) return null;
    const where = columns.map((column) => `${quoteIdent(column)} = ?`).join(" and ");
    const found = getSqliteDb()
      .prepare(`select id from ${quoteIdent(this.table)} where ${where} limit 1`)
      .get(...columns.map((column) => encode(row[column])));
    return found ?? null;
  }

  private executeUpdate(): Result<any> {
    const payload = this.payload as Row;
    const row: Row = {
      ...payload,
      updated_at: payload.updated_at ?? new Date().toISOString(),
    };
    ensureColumns(this.table, row);
    const keys = Object.keys(row);
    const sql = `update ${quoteIdent(this.table)} set ${keys
      .map((key) => `${quoteIdent(key)} = ?`)
      .join(", ")}${this.whereSql()}`;
    getSqliteDb().prepare(sql).run(...keys.map((key) => encode(row[key])), ...this.values);
    return this.executeSelect();
  }

  private executeDelete(): Result<any> {
    getSqliteDb().prepare(`delete from ${quoteIdent(this.table)}${this.whereSql()}`).run(...this.values);
    return { data: null, error: null };
  }
}

function safeJsonArrayFirst(value: string): unknown {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    return value;
  }
}

export function createServerSQLite(): any {
  return {
    from(table: string) {
      return new SqliteQueryBuilder(table);
    },
    rpc(name: string, args?: Row) {
      return sqliteRpc(name, args ?? {});
    },
    auth: {
      admin: {
        async getUserById(id: string) {
          const user = findLocalUserById(id);
          return { data: { user: user ? { ...user, factors: [] } : null }, error: null };
        },
        async deleteUser(id: string) {
          getSqliteDb().prepare("delete from local_users where id = ?").run(id);
          getSqliteDb().prepare("delete from local_sessions where user_id = ?").run(id);
          return { data: null, error: null };
        },
      },
    },
  };
}

async function sqliteRpc(name: string, args: Row): Promise<Result<any>> {
  try {
    if (name === "get_projects_overview") {
      return { data: await projectsOverview(args), error: null };
    }
    if (name === "get_chats_overview") {
      return { data: await chatsOverview(args), error: null };
    }
    if (name === "get_tabular_reviews_overview") {
      return { data: await tabularReviewsOverview(args), error: null };
    }
    if (name === "get_tabular_review_ids_overview") {
      return { data: await tabularReviewIdsOverview(args), error: null };
    }
    if (name === "get_workflows_overview") {
      return { data: await workflowsOverview(args), error: null };
    }
    if (name === "install_missing_default_workflows") {
      return {
        data: await installMissingDefaultWorkflows(args),
        error: null,
      };
    }
    if (name === "replace_user_router_models") {
      return { data: replaceUserRouterModels(args), error: null };
    }
    if (name === "begin_tabular_review_generation") {
      return { data: beginTabularReviewGeneration(args), error: null };
    }
    if (name === "renew_tabular_review_generation") {
      return { data: renewTabularReviewGeneration(args), error: null };
    }
    if (name === "finish_tabular_review_generation") {
      return { data: finishTabularReviewGeneration(args), error: null };
    }
    return { data: [], error: null };
  } catch (error) {
    return { data: null as any, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

// Mirrors the Postgres public.replace_user_router_models function: the whole
// saved selection for one router is swapped atomically, so a concurrent write
// can never interleave a delete with a partial insert.
function replaceUserRouterModels(args: Row): null {
  const userId = rpcUserId(args);
  const router = String(args.target_router ?? "").trim();
  if (!userId || !router) return null;
  const modelIds = Array.isArray(args.target_model_ids)
    ? (args.target_model_ids as unknown[]).flatMap((value) =>
        typeof value === "string" && value.trim() ? [value.trim()] : [],
      )
    : [];

  const db = getSqliteDb();
  ensureColumns("user_router_models", {
    user_id: null,
    router: null,
    model_id: null,
    sort_order: null,
  });
  db.exec("begin immediate");
  try {
    db.prepare(
      `delete from "user_router_models" where "user_id" = ? and "router" = ?`,
    ).run(userId, router);
    const insert = db.prepare(
      `insert into "user_router_models"
       (id, user_id, router, model_id, sort_order, created_at, updated_at)
       values (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    );
    modelIds.forEach((modelId, index) => {
      insert.run(crypto.randomUUID(), userId, router, modelId, index);
    });
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
  return null;
}

async function installMissingDefaultWorkflows(args: Row): Promise<number> {
  const userId = rpcUserId(args);
  const defaults = Array.isArray(args.p_defaults)
    ? (args.p_defaults as Row[])
    : [];
  if (!userId || defaults.length === 0) return 0;

  const db = createServerSQLite();
  let installed = 0;
  for (const item of defaults) {
    const defaultKey = String(item.default_key ?? "").trim();
    if (!defaultKey) continue;
    const { data: existing, error: lookupError } = await db
      .from("default_workflow_installations")
      .select("id")
      .eq("user_id", userId)
      .eq("default_key", defaultKey)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (existing) continue;

    const workflowId = crypto.randomUUID();
    const now = new Date().toISOString();
    const { error: workflowError } = await db.from("workflows").insert({
      id: workflowId,
      user_id: userId,
      title: item.title,
      type: item.type,
      prompt_md: item.prompt_md ?? null,
      columns_config: item.columns_config ?? null,
      language: item.language ?? "English",
      practice: item.practice ?? "General Transactions",
      jurisdictions: item.jurisdictions ?? ["General"],
      created_at: now,
      updated_at: now,
    });
    if (workflowError) throw workflowError;

    const { error: markerError } = await db
      .from("default_workflow_installations")
      .insert({
        user_id: userId,
        default_key: defaultKey,
        workflow_id: workflowId,
        installed_at: now,
      });
    if (markerError) throw markerError;

    const { error: actionError } = await db.from("quick_actions").insert({
      user_id: userId,
      workflow_id: workflowId,
      prompt: item.quick_action_prompt ?? "",
      document_upload: item.document_upload === true,
      enabled: true,
      sort_order: Number(item.sort_order ?? 0),
      created_at: now,
      updated_at: now,
    });
    if (actionError) throw actionError;
    installed += 1;
  }
  return installed;
}

async function selectRows(table: string): Promise<Row[]> {
  const { data, error } = await new SqliteQueryBuilder(table).select("*");
  if (error) throw error;
  return (data ?? []) as Row[];
}

// Mirrors migrations/20260822_01_tabular_generation_lease.sql. Without these
// the generic RPC fallback returns [], which the tabular routes read as "not
// started" and turn into a 500 on every generation.
function tabularLeaseSeconds(args: Row): number {
  const requested = Number(args.lease_seconds ?? 300);
  const seconds = Number.isFinite(requested) ? requested : 300;
  return Math.max(60, Math.min(seconds, 3600));
}

function ensureTabularLeaseColumns(): void {
  ensureColumns("tabular_reviews", {
    active_generation_id: null,
    generation_lease_expires_at: null,
  });
}

function beginTabularReviewGeneration(args: Row): string {
  const reviewId = String(args.target_review_id ?? "");
  const generationId = String(args.target_generation_id ?? "");
  if (!reviewId || !generationId) return "not_found";

  const db = getSqliteDb();
  ensureTabularLeaseColumns();
  db.exec("begin immediate");
  try {
    const review = db
      .prepare(`select * from "tabular_reviews" where "id" = ?`)
      .get(reviewId) as Row | undefined;
    if (!review) {
      db.exec("commit");
      return "not_found";
    }

    const leaseExpiry = review.generation_lease_expires_at;
    if (
      review.active_generation_id &&
      typeof leaseExpiry === "string" &&
      Date.parse(leaseExpiry) > Date.now()
    ) {
      db.exec("commit");
      return "running";
    }

    // `is distinct from` in the SQL original: both null counts as a match.
    const expected = args.expected_updated_at ?? null;
    const actual = review.updated_at ?? null;
    if (String(expected ?? "") !== String(actual ?? "")) {
      db.exec("commit");
      return "stale";
    }

    const expiresAt = new Date(
      Date.now() + tabularLeaseSeconds(args) * 1000,
    ).toISOString();
    db.prepare(
      `update "tabular_reviews"
          set "active_generation_id" = ?, "generation_lease_expires_at" = ?
        where "id" = ?`,
    ).run(generationId, expiresAt, reviewId);
    db.exec("commit");
    return "started";
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

function renewTabularReviewGeneration(args: Row): boolean {
  const reviewId = String(args.target_review_id ?? "");
  const generationId = String(args.target_generation_id ?? "");
  if (!reviewId || !generationId) return false;
  ensureTabularLeaseColumns();
  const expiresAt = new Date(
    Date.now() + tabularLeaseSeconds(args) * 1000,
  ).toISOString();
  const result = getSqliteDb()
    .prepare(
      `update "tabular_reviews"
          set "generation_lease_expires_at" = ?
        where "id" = ? and "active_generation_id" = ?`,
    )
    .run(expiresAt, reviewId, generationId) as { changes?: number };
  return Number(result?.changes ?? 0) > 0;
}

function finishTabularReviewGeneration(args: Row): boolean {
  const reviewId = String(args.target_review_id ?? "");
  const generationId = String(args.target_generation_id ?? "");
  if (!reviewId || !generationId) return false;
  ensureTabularLeaseColumns();
  const result = getSqliteDb()
    .prepare(
      `update "tabular_reviews"
          set "active_generation_id" = null, "generation_lease_expires_at" = null
        where "id" = ? and "active_generation_id" = ?`,
    )
    .run(reviewId, generationId) as { changes?: number };
  return Number(result?.changes ?? 0) > 0;
}

function rpcUserId(args: Row): string {
  return String(args.p_user_id ?? args.user_id ?? "");
}

function rpcUserEmail(args: Row): string {
  return String(args.p_user_email ?? args.user_email ?? "").trim().toLowerCase();
}

function createdDesc(a: Row, b: Row): number {
  return String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""));
}

function jsonListIncludes(value: unknown, needle: string): boolean {
  if (!needle) return false;
  if (Array.isArray(value)) {
    return value.some((item) => String(item).trim().toLowerCase() === needle);
  }
  if (typeof value === "string") {
    try {
      return jsonListIncludes(JSON.parse(value), needle);
    } catch {
      return value.trim().toLowerCase() === needle;
    }
  }
  return false;
}

function distinctCount(rows: Row[], column: string): number {
  return new Set(
    rows
      .map((row) => row[column])
      .filter((value) => value !== null && value !== undefined && value !== ""),
  ).size;
}

async function profileDisplayNames(): Promise<Map<string, string>> {
  const profiles = await selectRows("user_profiles");
  const names = new Map<string, string>();
  for (const profile of profiles) {
    const userId = typeof profile.user_id === "string" ? profile.user_id : "";
    const name = typeof profile.display_name === "string" ? profile.display_name.trim() : "";
    if (userId && name) names.set(userId, name);
  }
  return names;
}

async function projectsOverview(args: Row): Promise<Row[]> {
  const userId = rpcUserId(args);
  const userEmail = rpcUserEmail(args);
  const [projects, documents, chats, reviews, displayNames] = await Promise.all([
    selectRows("projects"),
    selectRows("documents"),
    selectRows("chats"),
    selectRows("tabular_reviews"),
    profileDisplayNames(),
  ]);
  return projects
    .filter(
      (project) =>
        project.user_id === userId ||
        (project.user_id !== userId && jsonListIncludes(project.shared_with, userEmail)),
    )
    .sort(createdDesc)
    .map((project) => ({
      ...project,
      is_owner: project.user_id === userId,
      owner_display_name: displayNames.get(String(project.user_id ?? "")) ?? null,
      owner_email: null,
      document_count: documents.filter((doc) => doc.project_id === project.id).length,
      chat_count: chats.filter((chat) => chat.project_id === project.id).length,
      review_count: reviews.filter((review) => review.project_id === project.id).length,
    }));
}

async function chatsOverview(args: Row): Promise<Row[]> {
  const userId = rpcUserId(args);
  const rawLimit = Number(args.p_limit ?? args.limit);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : null;
  const [chats, projects] = await Promise.all([selectRows("chats"), selectRows("projects")]);
  const ownedProjectIds = new Set(
    projects.filter((project) => project.user_id === userId).map((project) => project.id),
  );
  const rows = chats
    .filter((chat) => chat.user_id === userId || ownedProjectIds.has(chat.project_id))
    .sort(createdDesc)
    .map((chat) => ({
      id: chat.id,
      project_id: chat.project_id ?? null,
      user_id: chat.user_id,
      title: chat.title ?? null,
      created_at: chat.created_at,
    }));
  return limit ? rows.slice(0, limit) : rows;
}

// Mirrors the visible_reviews predicate of the Postgres
// get_tabular_reviews_overview / get_tabular_review_ids_overview RPCs
// (backend/migrations/20260726_01, 20260727_01). Keep the two providers'
// visibility, scope, and search semantics in sync.
async function visibleTabularReviews(args: Row): Promise<Row[]> {
  const userId = rpcUserId(args);
  const userEmail = rpcUserEmail(args);
  const projectId = typeof args.p_project_id === "string" && args.p_project_id ? args.p_project_id : null;
  const scope = args.p_scope === "in-project" || args.p_scope === "standalone" ? args.p_scope : "all";
  const searchTerm = typeof args.p_search_term === "string" ? args.p_search_term.trim().toLowerCase() : "";
  const [projects, reviews] = await Promise.all([
    selectRows("projects"),
    selectRows("tabular_reviews"),
  ]);
  const accessibleProjectIds = new Set(
    projects
      .filter(
        (project) =>
          project.user_id === userId ||
          (project.user_id !== userId && jsonListIncludes(project.shared_with, userEmail)),
      )
      .map((project) => project.id),
  );
  return reviews.filter((review) => {
    if (projectId && review.project_id !== projectId) return false;
    if (projectId && !accessibleProjectIds.has(projectId)) return false;
    if (scope === "in-project" && !review.project_id) return false;
    if (scope === "standalone" && review.project_id) return false;
    if (searchTerm && !String(review.title ?? "").toLowerCase().includes(searchTerm)) return false;
    if (review.user_id === userId) return true;
    if (review.project_id && accessibleProjectIds.has(review.project_id)) return true;
    return !projectId && jsonListIncludes(review.shared_with, userEmail);
  });
}

// Mirrors the Postgres `limit greatest(coalesce(p_limit, <default>), 1)
// offset greatest(coalesce(p_offset, 0), 0)` tail. Absent *and* null both
// fall back to the default, matching coalesce — Number(null) is 0, so
// these cannot be collapsed into a plain Number() check.
function rpcPageSlice<T>(rows: T[], args: Row, defaultLimit: number): T[] {
  const coalesceNumber = (value: unknown, fallback: number): number => {
    if (value === null || value === undefined) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const limit = Math.max(coalesceNumber(args.p_limit, defaultLimit), 1);
  const offset = Math.max(coalesceNumber(args.p_offset, 0), 0);
  return rows.slice(offset, offset + limit);
}

async function tabularReviewsOverview(args: Row): Promise<Row[]> {
  const userId = rpcUserId(args);
  const [visible, cells] = await Promise.all([
    visibleTabularReviews(args),
    selectRows("tabular_cells"),
  ]);
  const overview: Row[] = visible.map((review) => ({
    ...review,
    is_owner: review.user_id === userId,
    document_count: Array.isArray(review.document_ids)
      ? distinctCount(review.document_ids.map((id) => ({ id })), "id")
      : distinctCount(cells.filter((cell) => cell.review_id === review.id), "document_id"),
  }));
  const sortKey = typeof args.p_sort_key === "string" ? args.p_sort_key : "created";
  const direction = args.p_sort_direction === "asc" ? 1 : -1;
  const sortValue = (row: Row): string | number => {
    if (sortKey === "name") return String(row.title ?? "").toLowerCase();
    if (sortKey === "columns") return Array.isArray(row.columns_config) ? row.columns_config.length : 0;
    if (sortKey === "documents") return Number(row.document_count ?? 0);
    return String(row.created_at ?? "");
  };
  overview.sort((a, b) => {
    const left = sortValue(a);
    const right = sortValue(b);
    const primary = typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right));
    if (primary !== 0) return primary * direction;
    return createdDesc(a, b) || String(a["id"] ?? "").localeCompare(String(b["id"] ?? ""));
  });
  return rpcPageSlice(overview, args, 20);
}

async function tabularReviewIdsOverview(args: Row): Promise<Row[]> {
  const visible = await visibleTabularReviews(args);
  const ids = visible
    .sort((a, b) => createdDesc(a, b) || String(a.id ?? "").localeCompare(String(b.id ?? "")))
    .map((review) => ({ id: review.id, user_id: review.user_id }));
  return rpcPageSlice(ids, args, 1000);
}

async function workflowsOverview(args: Row): Promise<Row[]> {
  const userId = rpcUserId(args);
  const userEmail = rpcUserEmail(args);
  const type = typeof args.p_type === "string" && args.p_type ? args.p_type : null;
  const [workflows, shares, displayNames] = await Promise.all([
    selectRows("workflows"),
    selectRows("workflow_shares"),
    profileDisplayNames(),
  ]);
  const owned = workflows
    .filter((workflow) => workflow.user_id === userId && (!type || workflow.type === type))
    .map((workflow) => ({
      ...workflow,
      is_system: false,
      allow_edit: true,
      is_owner: true,
      shared_by_name: null,
      sort_bucket: 0,
    }));
  const workflowById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const shared = shares
    .filter(
      (share) =>
        String(share.shared_with_email ?? "").trim().toLowerCase() === userEmail,
    )
    .map((share) => ({ share, workflow: workflowById.get(share.workflow_id) }))
    .filter(({ workflow }) => workflow && (!type || workflow.type === type))
    .map(({ share, workflow }) => ({
      ...workflow!,
      is_system: false,
      allow_edit: share.allow_edit === true || share.allow_edit === 1 || share.allow_edit === "1",
      is_owner: false,
      shared_by_name: displayNames.get(String(share.shared_by_user_id ?? "")) ?? null,
      sort_bucket: 1,
    }));
  return [...owned, ...shared]
    .sort((a, b) => Number(a.sort_bucket ?? 0) - Number(b.sort_bucket ?? 0) || createdDesc(a, b))
    .map(({ sort_bucket: _sortBucket, ...row }) => row);
}

export async function getUserIdFromRequest(req: Request): Promise<string> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    throw new Response("Missing or invalid Authorization header", { status: 401 });
  }
  const session = findSession(auth.slice(7).trim());
  if (!session) throw new Response("Invalid or expired token", { status: 401 });
  return session.userId;
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function hashPassword(password: string, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const candidate = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, "hex");
  if (stored.length !== candidate.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

export function createSession(userId: string, mfaVerified = true): string {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
  getSqliteDb()
    .prepare("insert into local_sessions (token_hash, user_id, expires_at, mfa_verified) values (?, ?, ?, ?)")
    .run(hashToken(token), userId, expires, mfaVerified ? 1 : 0);
  return token;
}

export function findSession(token: string): { userId: string; mfaVerified: boolean } | null {
  const row = getSqliteDb()
    .prepare("select user_id, expires_at, mfa_verified from local_sessions where token_hash = ?")
    .get(hashToken(token));
  if (!row || String(row.expires_at) <= new Date().toISOString()) return null;
  return {
    userId: String(row.user_id),
    mfaVerified: row.mfa_verified === undefined || Number(row.mfa_verified) === 1,
  };
}

export function markSessionMfaVerified(token: string): void {
  getSqliteDb()
    .prepare("update local_sessions set mfa_verified = 1 where token_hash = ?")
    .run(hashToken(token));
}

export function deleteSession(token: string): void {
  getSqliteDb().prepare("delete from local_sessions where token_hash = ?").run(hashToken(token));
}

export function createLocalUser(email: string, password: string) {
  const normalized = email.trim().toLowerCase();
  const { hash, salt } = hashPassword(password);
  const id = crypto.randomUUID();
  getSqliteDb()
    .prepare(
      "insert into local_users (id, email, password_hash, password_salt, updated_at) values (?, ?, ?, ?, datetime('now'))",
    )
    .run(id, normalized, hash, salt);
  ensureLocalProfile(id, normalized);
  return { id, email: normalized };
}

export function findLocalUserByEmail(email: string) {
  const row = getSqliteDb()
    .prepare("select * from local_users where email = ?")
    .get(email.trim().toLowerCase());
  return row ? decodeRow(row) : null;
}

export function findLocalUserById(id: string) {
  const row = getSqliteDb().prepare("select * from local_users where id = ?").get(id);
  return row ? decodeRow(row) : null;
}

export function updateLocalUserEmail(id: string, email: string) {
  const normalized = email.trim().toLowerCase();
  getSqliteDb()
    .prepare("update local_users set email = ?, updated_at = datetime('now') where id = ?")
    .run(normalized, id);
  ensureLocalProfile(id, normalized);
  ensureColumns("user_profiles", { email: null, updated_at: null, user_id: null });
  getSqliteDb()
    .prepare("update user_profiles set email = ?, updated_at = datetime('now') where user_id = ?")
    .run(normalized, id);
  return { id, email: normalized };
}

export function ensureLocalProfile(userId: string, email?: string | null) {
  const now = new Date().toISOString();
  ensureColumns("user_profiles", { user_id: null });
  const existing = getSqliteDb()
    .prepare(`select id from "user_profiles" where "user_id" = ? limit 1`)
    .get(userId);
  if (existing) return;
  new SqliteQueryBuilder("user_profiles")
    .insert({
      user_id: userId,
      email: email?.toLowerCase() ?? null,
      tier: "Free",
      message_credits_used: 0,
      credits_reset_date: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(),
      tabular_model: "gemini-3-flash-preview",
      mfa_on_login: 0,
      legal_research_us: 1,
      feature_flags: {},
      updated_at: now,
    })
    .then(() => undefined);
}
