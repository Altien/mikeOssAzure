import fs from "node:fs";
import path from "node:path";
import { signDownload } from "../downloadTokens";
import type { FileContent, StorageProvider } from "./types";

type Statement = {
  run(...values: unknown[]): unknown;
  get(...values: unknown[]): Record<string, unknown> | undefined;
  all(...values: unknown[]): Record<string, unknown>[];
};

type Database = {
  exec(sql: string): void;
  prepare(sql: string): Statement;
};

type DatabaseSyncConstructor = new (filename: string) => Database;
let cachedDb: Database | undefined;

function loadDatabaseSync(): DatabaseSyncConstructor {
  try {
    return (require("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor })
      .DatabaseSync;
  } catch (error) {
    throw new Error(
      "The SQLite storage provider requires a Node runtime with node:sqlite support (Node 22 or newer).",
      { cause: error },
    );
  }
}

function storageDbPath(): string {
  return (
    process.env.SQLITE_STORAGE_PATH?.trim() ||
    path.join(process.cwd(), "data", "mike-files.sqlite")
  );
}

function getDb(): Database {
  if (!cachedDb) {
    const dbPath = storageDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const DatabaseSync = loadDatabaseSync();
    cachedDb = new DatabaseSync(dbPath);
    cachedDb.exec(`
      create table if not exists file_storage (
        key text primary key,
        content blob not null,
        content_type text not null,
        size_bytes integer not null,
        created_at text not null default (datetime('now')),
        updated_at text not null default (datetime('now'))
      );
      create index if not exists idx_file_storage_key_prefix
        on file_storage(key);
    `);
  }
  return cachedDb;
}

function toBuffer(content: FileContent): Buffer {
  return ArrayBuffer.isView(content)
    ? Buffer.from(content.buffer, content.byteOffset, content.byteLength)
    : Buffer.from(content);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export const sqliteStorageProvider: StorageProvider = {
  enabled: true,

  async uploadFile(key, content, contentType) {
    const buffer = toBuffer(content);
    getDb()
      .prepare(
        `
        insert into file_storage (key, content, content_type, size_bytes, updated_at)
        values (?, ?, ?, ?, datetime('now'))
        on conflict(key) do update set
          content = excluded.content,
          content_type = excluded.content_type,
          size_bytes = excluded.size_bytes,
          updated_at = datetime('now')
      `,
      )
      .run(key, buffer, contentType, buffer.byteLength);
  },

  async downloadFile(key) {
    const content = getDb()
      .prepare("select content from file_storage where key = ?")
      .get(key)?.content;
    if (!content) return null;
    const buffer = Buffer.isBuffer(content)
      ? content
      : Buffer.from(content as ArrayBuffer);
    return buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
  },

  async listFiles(prefix) {
    return getDb()
      .prepare(
        "select key from file_storage where key like ? escape '\\' order by key asc",
      )
      .all(`${escapeLike(prefix)}%`)
      .map((row) => String(row.key));
  },

  async deleteFile(key) {
    getDb().prepare("delete from file_storage where key = ?").run(key);
  },

  async getSignedUrl(key, expiresIn = 3600, downloadFilename) {
    return `/download/${signDownload(
      key,
      downloadFilename || path.basename(key),
      expiresIn,
    )}`;
  },
};
