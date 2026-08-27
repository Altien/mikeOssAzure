import crypto from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { guardedFetch } from "./mcp/client";
import {
  createServerDatabase,
  databaseProviderIsSQLite,
  type ServerDatabase,
} from "./database";
import { getSqliteDb } from "./sqlite";

type Db = ServerDatabase;

export const LEGAL_MONITOR_SOURCE_KINDS = ["rss", "web"] as const;
export type LegalMonitorSourceKind =
  (typeof LEGAL_MONITOR_SOURCE_KINDS)[number];

export type LegalMonitorSourceInput = {
  id?: string;
  kind: LegalMonitorSourceKind;
  name: string;
  url: string;
  category?: string | null;
  enabled: boolean;
};

export type LegalMonitorSource = {
  id: string;
  monitorId: string;
  kind: LegalMonitorSourceKind;
  name: string;
  url: string;
  category: string | null;
  enabled: boolean;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
};

export type LegalMonitorSourceItem = {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceKind: LegalMonitorSourceKind;
  category: string | null;
  title: string;
  url: string | null;
  publishedAt: string | null;
  summary: string;
  content: string;
};

type SourceRow = {
  id: string;
  monitor_id: string;
  user_id: string;
  kind: LegalMonitorSourceKind;
  name: string;
  url: string;
  category: string | null;
  enabled: boolean | number | string;
  etag: string | null;
  last_modified: string | null;
  last_checked_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  item_count: number | string;
  created_at: string;
  updated_at: string;
};

type ParsedSourceEntry = {
  externalId: string;
  title: string;
  url: string | null;
  publishedAt: string | null;
  summary: string;
  content: string;
};

const MAX_SOURCE_COUNT = 100;
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

export function ensureLegalMonitorSourceSchema(): void {
  if (!databaseProviderIsSQLite()) return;
  getSqliteDb().exec(`
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
    `);
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function publicSource(row: SourceRow): LegalMonitorSource {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    kind: row.kind,
    name: row.name,
    url: row.url,
    category: row.category,
    enabled: truthy(row.enabled),
    lastCheckedAt: row.last_checked_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    itemCount: Number(row.item_count) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Each monitor source must have a valid URL.");
  }
  if (url.protocol !== "https:")
    throw new Error("Monitor source URLs must use HTTPS.");
  url.username = "";
  url.password = "";
  url.hash = "";
  return url.toString();
}

export function validateLegalMonitorSources(
  rawSources: LegalMonitorSourceInput[],
): LegalMonitorSourceInput[] {
  if (!Array.isArray(rawSources))
    throw new Error("Monitor sources must be an array.");
  if (rawSources.length > MAX_SOURCE_COUNT)
    throw new Error(`A monitor may have at most ${MAX_SOURCE_COUNT} sources.`);
  const seen = new Set<string>();
  return rawSources.map((raw, index) => {
    if (!LEGAL_MONITOR_SOURCE_KINDS.includes(raw.kind))
      throw new Error(`Source ${index + 1} has an unsupported type.`);
    const name = raw.name?.trim().slice(0, 160);
    if (!name) throw new Error(`Source ${index + 1} needs a name.`);
    const url = normalizeUrl(raw.url ?? "");
    const key = `${raw.kind}:${url}`;
    if (seen.has(key)) throw new Error(`Duplicate monitor source: ${name}.`);
    seen.add(key);
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : undefined,
      kind: raw.kind,
      name,
      url,
      category: raw.category?.trim().slice(0, 120) || null,
      enabled: raw.enabled !== false,
    };
  });
}

export async function listLegalMonitorSources(
  userId: string,
  monitorId: string,
  db: Db = createServerDatabase(),
): Promise<LegalMonitorSource[]> {
  ensureLegalMonitorSourceSchema();
  const { data, error } = await db
    .from("legal_monitor_sources")
    .select("*")
    .eq("monitor_id", monitorId)
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as SourceRow[]).map(publicSource);
}

export async function replaceLegalMonitorSources(
  userId: string,
  monitorId: string,
  rawSources: LegalMonitorSourceInput[],
  db: Db = createServerDatabase(),
): Promise<LegalMonitorSource[]> {
  ensureLegalMonitorSourceSchema();
  const sources = validateLegalMonitorSources(rawSources);
  const existing = await listLegalMonitorSources(userId, monitorId, db);
  const existingById = new Map(existing.map((source) => [source.id, source]));
  const existingByKey = new Map(
    existing.map((source) => [`${source.kind}:${source.url}`, source]),
  );
  const retained = new Set<string>();
  const now = new Date().toISOString();

  for (const source of sources) {
    const prior =
      (source.id && existingById.get(source.id)) ||
      existingByKey.get(`${source.kind}:${source.url}`);
    if (prior) {
      retained.add(prior.id);
      const { error } = await db
        .from("legal_monitor_sources")
        .update({
          kind: source.kind,
          name: source.name,
          url: source.url,
          category: source.category ?? null,
          enabled: source.enabled,
          updated_at: now,
        })
        .eq("id", prior.id)
        .eq("user_id", userId)
        .eq("monitor_id", monitorId);
      if (error) throw error;
      continue;
    }
    const id = crypto.randomUUID();
    retained.add(id);
    const { error } = await db.from("legal_monitor_sources").insert({
      id,
      monitor_id: monitorId,
      user_id: userId,
      kind: source.kind,
      name: source.name,
      url: source.url,
      category: source.category ?? null,
      enabled: source.enabled,
      etag: null,
      last_modified: null,
      last_checked_at: null,
      last_success_at: null,
      last_error: null,
      item_count: 0,
      created_at: now,
      updated_at: now,
    });
    if (error) throw error;
  }

  for (const prior of existing) {
    if (retained.has(prior.id)) continue;
    const itemDelete = await db
      .from("legal_monitor_source_items")
      .delete()
      .eq("source_id", prior.id)
      .eq("user_id", userId);
    if (itemDelete.error) throw itemDelete.error;
    const sourceDelete = await db
      .from("legal_monitor_sources")
      .delete()
      .eq("id", prior.id)
      .eq("user_id", userId);
    if (sourceDelete.error) throw sourceDelete.error;
  }
  return listLegalMonitorSources(userId, monitorId, db);
}

function arrayOf<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function stringValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number")
    return String(value).trim();
  if (!value || typeof value !== "object") return "";
  const row = value as Record<string, unknown>;
  return stringValue(row["#text"] ?? row.__cdata ?? row._ ?? "");
}

function cleanText(value: unknown, maxLength = 12_000): string {
  return stringValue(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim()
    .slice(0, maxLength);
}

function entryLink(value: unknown): string | null {
  for (const link of arrayOf(value)) {
    if (typeof link === "string" && /^https?:\/\//i.test(link.trim()))
      return link.trim();
    if (link && typeof link === "object") {
      const row = link as Record<string, unknown>;
      const href = stringValue(row.href ?? row.url ?? row["@_href"]);
      const rel = stringValue(row.rel ?? row["@_rel"]);
      if (href && /^https?:\/\//i.test(href) && (!rel || rel === "alternate"))
        return href;
    }
  }
  return null;
}

function parseDate(value: unknown): string | null {
  const text = stringValue(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parsedEntry(raw: Record<string, unknown>): ParsedSourceEntry | null {
  const title = cleanText(raw.title, 500) || "Untitled source item";
  const url = entryLink(raw.link) || entryLink(raw.guid);
  const publishedAt = parseDate(
    raw.pubDate ?? raw.published ?? raw.updated ?? raw["dc:date"] ?? raw.date,
  );
  const summary = cleanText(
    raw.summary ?? raw.description ?? raw["content:encoded"] ?? raw.content,
    6_000,
  );
  const content =
    cleanText(
      raw["content:encoded"] ?? raw.content ?? raw.description ?? raw.summary,
      12_000,
    ) || summary;
  const idValue =
    stringValue(raw.id ?? raw.guid) || url || `${title}|${publishedAt ?? ""}`;
  if (!idValue && !content) return null;
  return {
    externalId: crypto.createHash("sha256").update(idValue).digest("hex"),
    title,
    url,
    publishedAt,
    summary,
    content,
  };
}

export function parseFeedXml(xml: string): ParsedSourceEntry[] {
  if (!xml.trim()) throw new Error("Feed response was empty.");
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    processEntities: false,
    trimValues: true,
  });
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(xml) as Record<string, unknown>;
  } catch {
    throw new Error("Source did not return valid RSS or Atom XML.");
  }
  const rssChannel = (parsed.rss as Record<string, unknown> | undefined)
    ?.channel as Record<string, unknown> | undefined;
  const atomFeed = parsed.feed as Record<string, unknown> | undefined;
  const rdf = parsed["rdf:RDF"] as Record<string, unknown> | undefined;
  const rawEntries = arrayOf(
    (rssChannel?.item ?? atomFeed?.entry ?? rdf?.item) as
      | Record<string, unknown>
      | Record<string, unknown>[]
      | undefined,
  );
  if (!rssChannel && !atomFeed && !rdf)
    throw new Error("Source did not return an RSS or Atom feed.");
  return rawEntries.flatMap((entry) => {
    const normalized = parsedEntry(entry);
    return normalized ? [normalized] : [];
  });
}

export function parseOpmlSources(opml: string): LegalMonitorSourceInput[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    processEntities: false,
    trimValues: true,
  });
  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(opml) as Record<string, unknown>;
  } catch {
    throw new Error("The selected file is not valid OPML/XML.");
  }
  const root = parsed.opml as Record<string, unknown> | undefined;
  const body = root?.body as Record<string, unknown> | undefined;
  if (!body)
    throw new Error("The selected file does not contain an OPML body.");
  const collected: LegalMonitorSourceInput[] = [];
  const visit = (value: unknown, category: string | null) => {
    for (const outline of arrayOf(value)) {
      if (!outline || typeof outline !== "object") continue;
      const row = outline as Record<string, unknown>;
      const label = stringValue(row.title ?? row.text);
      const xmlUrl = stringValue(row.xmlUrl ?? row.xmlurl);
      if (xmlUrl)
        collected.push({
          kind: "rss",
          name: label || new URL(xmlUrl).hostname,
          url: xmlUrl,
          category,
          enabled: true,
        });
      visit(row.outline, xmlUrl ? category : label || category);
    }
  };
  visit(body.outline, null);
  if (!collected.length)
    throw new Error("The OPML file does not contain any feed URLs.");
  return validateLegalMonitorSources(collected);
}

async function readLimitedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_SOURCE_BYTES)
    throw new Error("Source response is larger than 5 MB.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_SOURCE_BYTES) {
      await reader.cancel();
      throw new Error("Source response is larger than 5 MB.");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function webEntry(source: SourceRow, html: string): ParsedSourceEntry {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const content = cleanText(html, 30_000);
  const title = cleanText(titleMatch?.[1], 500) || source.name;
  return {
    externalId: crypto.createHash("sha256").update(source.url).digest("hex"),
    title,
    url: source.url,
    publishedAt: new Date().toISOString(),
    summary: content.slice(0, 6_000),
    content,
  };
}

async function storeEntry(
  userId: string,
  monitorId: string,
  source: SourceRow,
  entry: ParsedSourceEntry,
  db: Db,
  now: string,
): Promise<void> {
  const contentHash = crypto
    .createHash("sha256")
    .update(`${entry.title}\n${entry.summary}\n${entry.content}`)
    .digest("hex");
  const { data, error } = await db
    .from("legal_monitor_source_items")
    .select("id, content_hash")
    .eq("source_id", source.id)
    .eq("external_id", entry.externalId)
    .maybeSingle();
  if (error) throw error;
  if (data) {
    const changed = data.content_hash !== contentHash;
    const update = await db
      .from("legal_monitor_source_items")
      .update({
        canonical_url: entry.url,
        title: entry.title,
        published_at: entry.publishedAt,
        summary: entry.summary,
        content: entry.content,
        content_hash: contentHash,
        last_seen_at: now,
        ...(changed ? { processed_at: null } : {}),
        updated_at: now,
      })
      .eq("id", data.id)
      .eq("user_id", userId);
    if (update.error) throw update.error;
    return;
  }
  const insert = await db.from("legal_monitor_source_items").insert({
    id: crypto.randomUUID(),
    monitor_id: monitorId,
    source_id: source.id,
    user_id: userId,
    external_id: entry.externalId,
    canonical_url: entry.url,
    title: entry.title,
    published_at: entry.publishedAt,
    summary: entry.summary,
    content: entry.content,
    content_hash: contentHash,
    first_seen_at: now,
    last_seen_at: now,
    processed_at: null,
    created_at: now,
    updated_at: now,
  });
  if (insert.error) throw insert.error;
}

async function fetchSource(
  userId: string,
  monitorId: string,
  source: SourceRow,
  lookbackDays: number,
  db: Db,
): Promise<string | null> {
  const now = new Date().toISOString();
  const headers: Record<string, string> = {
    Accept:
      source.kind === "rss"
        ? "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5"
        : "text/html, application/xhtml+xml;q=0.9, */*;q=0.5",
    "User-Agent": "MikeOSS-Legal-Monitor/1.0",
  };
  if (source.etag) headers["If-None-Match"] = source.etag;
  if (source.last_modified) headers["If-Modified-Since"] = source.last_modified;
  try {
    const response = await guardedFetch(source.url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 304) {
      await db
        .from("legal_monitor_sources")
        .update({
          last_checked_at: now,
          last_success_at: now,
          last_error: null,
          updated_at: now,
        })
        .eq("id", source.id)
        .eq("user_id", userId);
      return null;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await readLimitedText(response);
    const entries =
      source.kind === "rss" ? parseFeedXml(body) : [webEntry(source, body)];
    const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
    let stored = 0;
    for (const entry of entries) {
      if (entry.publishedAt && new Date(entry.publishedAt).getTime() < cutoff)
        continue;
      await storeEntry(userId, monitorId, source, entry, db, now);
      stored += 1;
    }
    let itemCount = stored;
    if (databaseProviderIsSQLite()) {
      const countRow = getSqliteDb()
        .prepare(
          "select count(*) as count from legal_monitor_source_items where source_id = ? and user_id = ?",
        )
        .get(source.id, userId);
      itemCount = Number(countRow?.count) || stored;
    } else {
      const existingItems = await db
        .from("legal_monitor_source_items")
        .select("id")
        .eq("source_id", source.id)
        .eq("user_id", userId);
      if (existingItems.error) throw existingItems.error;
      itemCount = existingItems.data?.length ?? stored;
    }
    await db
      .from("legal_monitor_sources")
      .update({
        etag: response.headers.get("etag"),
        last_modified: response.headers.get("last-modified"),
        last_checked_at: now,
        last_success_at: now,
        last_error: null,
        item_count: itemCount,
        updated_at: now,
      })
      .eq("id", source.id)
      .eq("user_id", userId);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .from("legal_monitor_sources")
      .update({
        last_checked_at: now,
        last_error: message.slice(0, 1000),
        updated_at: now,
      })
      .eq("id", source.id)
      .eq("user_id", userId);
    return `${source.name}: ${message}`;
  }
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => run()),
  );
}

export async function collectLegalMonitorSourceItems(
  userId: string,
  monitorId: string,
  lookbackDays: number,
  maxItems: number,
  db: Db = createServerDatabase(),
): Promise<{
  items: LegalMonitorSourceItem[];
  errors: string[];
  sourceCount: number;
}> {
  ensureLegalMonitorSourceSchema();
  const sourcesResult = await db
    .from("legal_monitor_sources")
    .select("*")
    .eq("monitor_id", monitorId)
    .eq("user_id", userId)
    .eq("enabled", true)
    .order("created_at", { ascending: true });
  if (sourcesResult.error) throw sourcesResult.error;
  const sources = (sourcesResult.data ?? []) as SourceRow[];
  const errors: string[] = [];
  await mapLimit(sources, 4, async (source) => {
    const error = await fetchSource(
      userId,
      monitorId,
      source,
      lookbackDays,
      db,
    );
    if (error) errors.push(error);
  });

  const pending = await db
    .from("legal_monitor_source_items")
    .select("*")
    .eq("monitor_id", monitorId)
    .eq("user_id", userId)
    .is("processed_at", null)
    .order("published_at", { ascending: false })
    .limit(Math.min(Math.max(maxItems, 1), 100));
  if (pending.error) throw pending.error;
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const items = ((pending.data ?? []) as Record<string, unknown>[]).flatMap(
    (row): LegalMonitorSourceItem[] => {
      const source = sourceById.get(row.source_id as string);
      if (!source) return [];
      return [
        {
          id: row.id as string,
          sourceId: source.id,
          sourceName: source.name,
          sourceKind: source.kind,
          category: source.category,
          title: row.title as string,
          url: (row.canonical_url as string | null) ?? null,
          publishedAt: (row.published_at as string | null) ?? null,
          summary: (row.summary as string | null) ?? "",
          content: (row.content as string | null) ?? "",
        },
      ];
    },
  );
  return { items, errors, sourceCount: sources.length };
}

export async function markLegalMonitorSourceItemsProcessed(
  userId: string,
  itemIds: string[],
  completedAt: string,
  db: Db = createServerDatabase(),
): Promise<void> {
  if (!itemIds.length) return;
  const result = await db
    .from("legal_monitor_source_items")
    .update({ processed_at: completedAt, updated_at: completedAt })
    .eq("user_id", userId)
    .in("id", itemIds);
  if (result.error) throw result.error;
}

export async function deleteLegalMonitorSourceData(
  userId: string,
  monitorId: string,
  db: Db = createServerDatabase(),
): Promise<void> {
  const itemDelete = await db
    .from("legal_monitor_source_items")
    .delete()
    .eq("monitor_id", monitorId)
    .eq("user_id", userId);
  if (itemDelete.error) throw itemDelete.error;
  const sourceDelete = await db
    .from("legal_monitor_sources")
    .delete()
    .eq("monitor_id", monitorId)
    .eq("user_id", userId);
  if (sourceDelete.error) throw sourceDelete.error;
}
