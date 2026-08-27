import crypto from "node:crypto";
import {
  executeMcpToolCall,
  getUserMcpConnector,
  type McpConnectorSummary,
  type McpToolSummary,
} from "./mcpConnectors";
import {
  createServerDatabase,
  databaseProviderIsSQLite,
  type ServerDatabase,
} from "./database";
import { getSqliteDb } from "./sqlite";

type Db = ServerDatabase;

export type LegalMonitorConnectorConfig =
  | { mode: "agent" }
  | {
      mode: "trademark_prefix";
      prefix: string;
      status: "all" | "live" | "dead";
      internationalClass: string | null;
    };

export type TrademarkSearchPage = {
  results: Array<Record<string, unknown>>;
  total: number;
  hasMore: boolean;
};

export type CollectedConnectorSource = {
  dossier: string;
  itemIds: string[];
  itemCount: number;
  toolCalls: number;
};

type ConnectorItemRow = {
  id: string;
  monitor_id: string;
  user_id: string;
  connector_id: string;
  tool_name: string;
  external_id: string;
  payload: string | Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
};

const TRADEMARK_TOOL_NAME = "tm_search_trademarks";
const TRADEMARK_PAGE_SIZE = 5;
const MAX_TRADEMARK_RESULTS_PER_RUN = 250;

export function ensureLegalMonitorConnectorSourceSchema(): void {
  if (!databaseProviderIsSQLite()) return;
  getSqliteDb().exec(`
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
    `);
}

export function parseLegalMonitorConnectorConfig(
  value: unknown,
): LegalMonitorConnectorConfig {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== "object") return { mode: "agent" };
  const row = parsed as Record<string, unknown>;
  if (row.mode !== "trademark_prefix") return { mode: "agent" };

  const prefix =
    typeof row.prefix === "string"
      ? row.prefix.trim().replace(/\s+/g, " ")
      : "";
  if (!prefix || prefix.length > 80) {
    throw new Error(
      "Trademark prefix is required and must be 80 characters or fewer.",
    );
  }
  const status =
    row.status === "dead" || row.status === "all" ? row.status : "live";
  const rawClass =
    typeof row.internationalClass === "string"
      ? row.internationalClass.trim()
      : "";
  let internationalClass: string | null = null;
  if (rawClass) {
    const classNumber = Number(rawClass);
    if (!Number.isInteger(classNumber) || classNumber < 1 || classNumber > 45) {
      throw new Error("Trademark class must be a number from 1 through 45.");
    }
    internationalClass = String(classNumber);
  }
  return { mode: "trademark_prefix", prefix, status, internationalClass };
}

export function connectorSupportsTrademarkPrefix(
  connector: Pick<McpConnectorSummary, "tools">,
): boolean {
  return connector.tools.some(
    (tool) =>
      tool.toolName === TRADEMARK_TOOL_NAME &&
      tool.enabled &&
      !tool.requiresConfirmation,
  );
}

export async function assertMonitorConnector(
  userId: string,
  connectorId: string,
  config: LegalMonitorConnectorConfig,
  db: Db = createServerDatabase(),
): Promise<McpConnectorSummary> {
  let connector: McpConnectorSummary;
  try {
    connector = await getUserMcpConnector(userId, connectorId, db);
  } catch {
    throw new Error("The selected connector was not found.");
  }
  if (!connector.enabled)
    throw new Error("The selected connector is disabled.");
  const availableTools = connector.tools.filter(
    (tool) => tool.enabled && !tool.requiresConfirmation,
  );
  if (!availableTools.length)
    throw new Error("The selected connector has no unattended tools enabled.");
  if (
    config.mode === "trademark_prefix" &&
    !connectorSupportsTrademarkPrefix(connector)
  ) {
    throw new Error(
      "The selected connector does not expose an enabled unattended tm_search_trademarks tool.",
    );
  }
  return connector;
}

function escapeQueryStringTerm(value: string): string {
  return value
    .replace(/([+\-=!(){}[\]^"~*?:\\/]|&&|\|\|)/g, "\\$1")
    .replace(/\s/g, "\\ ");
}

export function buildTrademarkPrefixQuery(
  prefix: string,
  sinceDate: string,
): string {
  const tokens = prefix.split(/\s+/).filter(Boolean).map(escapeQueryStringTerm);
  const wordmarkQuery =
    tokens.length === 1
      ? `wordmark:${tokens[0]}*`
      : `wordmark:(${tokens.map((token, index) => (index === tokens.length - 1 ? `${token}*` : token)).join(" AND ")})`;
  return `${wordmarkQuery} AND registrationDate:[${sinceDate} TO *]`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function findTrademarkEnvelope(
  value: unknown,
  seen = new Set<unknown>(),
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  const row = value as Record<string, unknown>;
  if (Array.isArray(row.results) || row.error === true || row.success === false)
    return row;
  for (const candidate of [row.structuredContent, row.result]) {
    const found = findTrademarkEnvelope(candidate, seen);
    if (found) return found;
  }
  if (Array.isArray(row.content)) {
    for (const item of row.content) {
      if (!item || typeof item !== "object") continue;
      const text = (item as Record<string, unknown>).text;
      if (typeof text !== "string") continue;
      const found = findTrademarkEnvelope(parseJson(text), seen);
      if (found) return found;
    }
  }
  return null;
}

export function extractTrademarkSearchPage(
  content: string,
): TrademarkSearchPage {
  const parsed = parseJson(content);
  const envelope = findTrademarkEnvelope(parsed);
  if (!envelope) {
    throw new Error(
      "The trademark connector returned an unsupported response shape.",
    );
  }
  if (envelope.error === true || envelope.success === false) {
    const message =
      typeof envelope.message === "string"
        ? envelope.message
        : "Trademark search failed.";
    throw new Error(message);
  }
  const rawResults = Array.isArray(envelope.results) ? envelope.results : [];
  const results = rawResults.filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === "object" && !Array.isArray(item),
  );
  const totalValue = Number(envelope.total);
  const total =
    Number.isFinite(totalValue) && totalValue >= 0
      ? totalValue
      : results.length;
  return {
    results,
    total,
    hasMore:
      envelope.has_more === true ||
      Number(envelope.offset ?? 0) + results.length < total,
  };
}

function recordString(
  record: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return "";
}

function recordStrings(
  record: Record<string, unknown>,
  ...keys: string[]
): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter(Boolean);
    }
    const single = recordString(record, key);
    if (single) return [single];
  }
  return [];
}

function trademarkExternalId(record: Record<string, unknown>): string {
  return recordString(record, "id", "serialNumber", "serial_number");
}

function isMatchingRegistration(
  record: Record<string, unknown>,
  prefix: string,
  sinceDate: string,
): boolean {
  const wordmark = recordString(record, "wordmark", "markText", "mark_text");
  const registrationDate = recordString(
    record,
    "registrationDate",
    "registration_date",
  );
  return (
    !!trademarkExternalId(record) &&
    wordmark.toLocaleUpperCase().startsWith(prefix.toLocaleUpperCase()) &&
    /^\d{4}-\d{2}-\d{2}/.test(registrationDate) &&
    registrationDate.slice(0, 10) >= sinceDate
  );
}

function parsePayload(
  value: ConnectorItemRow["payload"],
): Record<string, unknown> {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return {};
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

async function storeTrademarkRecords(
  userId: string,
  monitorId: string,
  connectorId: string,
  records: Record<string, unknown>[],
  db: Db,
): Promise<void> {
  ensureLegalMonitorConnectorSourceSchema();
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("legal_monitor_connector_items")
    .select("*")
    .eq("monitor_id", monitorId)
    .eq("user_id", userId)
    .eq("connector_id", connectorId)
    .eq("tool_name", TRADEMARK_TOOL_NAME);
  if (error) throw error;
  const existing = new Map(
    ((data ?? []) as ConnectorItemRow[]).map((row) => [row.external_id, row]),
  );

  for (const record of records) {
    const externalId = trademarkExternalId(record);
    if (!externalId) continue;
    const prior = existing.get(externalId);
    if (prior) {
      const updated = await db
        .from("legal_monitor_connector_items")
        .update({
          payload: record,
          last_seen_at: now,
          updated_at: now,
        })
        .eq("id", prior.id)
        .eq("user_id", userId);
      if (updated.error) throw updated.error;
      continue;
    }
    const inserted = await db.from("legal_monitor_connector_items").insert({
      id: crypto.randomUUID(),
      monitor_id: monitorId,
      user_id: userId,
      connector_id: connectorId,
      tool_name: TRADEMARK_TOOL_NAME,
      external_id: externalId,
      payload: record,
      first_seen_at: now,
      last_seen_at: now,
      processed_at: null,
      created_at: now,
      updated_at: now,
    });
    if (inserted.error) throw inserted.error;
  }
}

async function pendingTrademarkItems(
  userId: string,
  monitorId: string,
  maxItems: number,
  db: Db,
): Promise<ConnectorItemRow[]> {
  const { data, error } = await db
    .from("legal_monitor_connector_items")
    .select("*")
    .eq("monitor_id", monitorId)
    .eq("user_id", userId)
    .eq("tool_name", TRADEMARK_TOOL_NAME)
    .order("first_seen_at", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as ConnectorItemRow[])
    .filter((row) => !row.processed_at)
    .slice(0, maxItems);
}

function trademarkDossier(
  items: ConnectorItemRow[],
  connectorName: string,
): { dossier: string; itemIds: string[] } {
  const sections: string[] = [];
  const itemIds: string[] = [];
  let remaining = 55_000;
  for (const item of items) {
    const record = parsePayload(item.payload);
    const serial = trademarkExternalId(record);
    const registration = recordString(
      record,
      "registrationId",
      "registrationNumber",
      "registration_number",
    );
    const owner = recordStrings(
      record,
      "ownerName",
      "ownerFullText",
      "owner_name",
    )
      .join("; ")
      .slice(0, 600);
    const classes = recordStrings(
      record,
      "internationalClass",
      "international_class",
    )
      .join(", ")
      .slice(0, 300);
    const status = recordString(
      record,
      "statusDescription",
      "status",
      "statusCode",
    );
    const goods = recordStrings(record, "goodsAndServices", "goods_services")
      .join(" ")
      .slice(0, 1_200);
    const description = recordStrings(
      record,
      "markDescription",
      "mark_description",
    )
      .join(" ")
      .slice(0, 500);
    const section = [
      `TRADEMARK: ${recordString(record, "wordmark", "markText", "mark_text") || "Unnamed mark"}`,
      `Connector: ${connectorName}`,
      `Serial number: ${serial}`,
      `Registration number: ${registration || "not provided"}`,
      `Registration date: ${recordString(record, "registrationDate", "registration_date") || "not provided"}`,
      `Owner: ${owner || "not provided"}`,
      `International class: ${classes || "not provided"}`,
      `Status: ${status || "not provided"}`,
      `Goods and services: ${goods || "not provided"}`,
      `Mark description: ${description || "not provided"}`,
      `TSDR: https://tsdr.uspto.gov/#caseNumber=${encodeURIComponent(serial)}&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch`,
    ].join("\n");
    if (section.length > remaining) break;
    sections.push(section);
    itemIds.push(item.id);
    remaining -= section.length;
  }
  return { dossier: sections.join("\n\n---\n\n"), itemIds };
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export async function collectTrademarkPrefixSource(input: {
  userId: string;
  monitorId: string;
  connector: McpConnectorSummary;
  config: Extract<LegalMonitorConnectorConfig, { mode: "trademark_prefix" }>;
  lookbackDays: number;
  previousCompletedAt: string | null;
  maxItems: number;
  db?: Db;
  executeTool?: typeof executeMcpToolCall;
}): Promise<CollectedConnectorSource> {
  const db = input.db ?? createServerDatabase();
  const executeTool = input.executeTool ?? executeMcpToolCall;
  ensureLegalMonitorConnectorSourceSchema();
  const tool = input.connector.tools.find(
    (candidate): candidate is McpToolSummary =>
      candidate.toolName === TRADEMARK_TOOL_NAME &&
      candidate.enabled &&
      !candidate.requiresConfirmation,
  );
  if (!tool)
    throw new Error(
      "The trademark search tool is no longer enabled on the selected connector.",
    );

  const since = input.previousCompletedAt
    ? new Date(input.previousCompletedAt)
    : new Date(Date.now() - input.lookbackDays * 24 * 60 * 60 * 1000);
  if (Number.isNaN(since.getTime()))
    throw new Error("Could not determine the trademark search window.");
  const sinceDate = dateOnly(since);
  const records = new Map<string, Record<string, unknown>>();
  let offset = 0;
  let toolCalls = 0;

  while (offset < MAX_TRADEMARK_RESULTS_PER_RUN) {
    const args: Record<string, unknown> = {
      query: buildTrademarkPrefixQuery(input.config.prefix, sinceDate),
      offset,
      limit: TRADEMARK_PAGE_SIZE,
    };
    if (input.config.status !== "all") args.status_filter = input.config.status;
    if (input.config.internationalClass)
      args.international_class = input.config.internationalClass;

    toolCalls += 1;
    const executed = await executeTool(
      input.userId,
      tool.openaiToolName,
      args,
      db,
    );
    if (executed.event.status !== "ok") {
      throw new Error(
        executed.event.error || "Trademark connector search failed.",
      );
    }
    const page = extractTrademarkSearchPage(executed.content);
    if (page.total > MAX_TRADEMARK_RESULTS_PER_RUN) {
      throw new Error(
        `Trademark search returned ${page.total} recent records. Narrow the prefix or select a Nice class so the result is at most ${MAX_TRADEMARK_RESULTS_PER_RUN}.`,
      );
    }
    for (const record of page.results) {
      if (!isMatchingRegistration(record, input.config.prefix, sinceDate))
        continue;
      records.set(trademarkExternalId(record), record);
    }
    offset += page.results.length;
    if (!page.hasMore || page.results.length === 0 || offset >= page.total)
      break;
  }

  await storeTrademarkRecords(
    input.userId,
    input.monitorId,
    input.connector.id,
    [...records.values()],
    db,
  );
  const pending = await pendingTrademarkItems(
    input.userId,
    input.monitorId,
    input.maxItems,
    db,
  );
  const dossier = trademarkDossier(pending, input.connector.name);
  return {
    dossier: dossier.dossier,
    itemIds: dossier.itemIds,
    itemCount: dossier.itemIds.length,
    toolCalls,
  };
}

export async function markLegalMonitorConnectorItemsProcessed(
  userId: string,
  itemIds: string[],
  processedAt: string,
  db: Db = createServerDatabase(),
): Promise<void> {
  if (!itemIds.length) return;
  ensureLegalMonitorConnectorSourceSchema();
  const { error } = await db
    .from("legal_monitor_connector_items")
    .update({
      processed_at: processedAt,
      updated_at: processedAt,
    })
    .eq("user_id", userId)
    .in("id", itemIds);
  if (error) throw error;
}

export async function deleteLegalMonitorConnectorSourceData(
  userId: string,
  monitorId: string,
  db: Db = createServerDatabase(),
): Promise<void> {
  ensureLegalMonitorConnectorSourceSchema();
  const { error } = await db
    .from("legal_monitor_connector_items")
    .delete()
    .eq("monitor_id", monitorId)
    .eq("user_id", userId);
  if (error) throw error;
}
