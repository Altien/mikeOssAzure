import { createHash } from "node:crypto";
import { completeText, type UserApiKeys } from "../llm";
import { createServerSupabase } from "../supabase";

export type ExternalSourceDocument = {
  id: string;
  provider: string;
  externalId: string;
  versionId: string;
  title: string;
  text: string;
  originUrl?: string;
  searchTool: string;
  readTool: string;
};

export type ExternalSourceSummary = {
  text: string;
  status: "generated" | "fallback";
  model: string | null;
};

export type CachedExternalSource = {
  cacheRecordId: string | null;
  source: ExternalSourceDocument;
  contentHash: string;
  summary: ExternalSourceSummary | null;
};

export type ExternalSourceSummarizer = (
  source: ExternalSourceDocument,
) => Promise<string>;

export type ExternalSourcePersistence = {
  storeSource(
    source: ExternalSourceDocument,
    hash: string,
  ): Promise<{ id: string; summary: ExternalSourceSummary | null }>;
  storeSummary(
    id: string,
    summary: ExternalSourceSummary,
  ): Promise<void>;
  findSource(id: string): Promise<CachedExternalSource | null>;
};

type ExternalSourceRow = {
  id: string;
  source_key: string;
  provider: string;
  external_id: string;
  version_id: string;
  title: string;
  origin_url: string | null;
  search_tool: string;
  read_tool: string;
  content_text: string;
  content_hash: string;
  summary_text: string | null;
  summary_status: "pending" | "generated" | "fallback";
  summary_model: string | null;
};

function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fromStoredRow(row: ExternalSourceRow): CachedExternalSource {
  return {
    cacheRecordId: row.id,
    source: {
      id: row.source_key,
      provider: row.provider,
      externalId: row.external_id,
      versionId: row.version_id,
      title: row.title,
      text: row.content_text,
      ...(row.origin_url ? { originUrl: row.origin_url } : {}),
      searchTool: row.search_tool,
      readTool: row.read_tool,
    },
    contentHash: row.content_hash,
    summary:
      row.summary_status === "pending" || !row.summary_text
        ? null
        : {
            text: row.summary_text,
            status: row.summary_status,
            model: row.summary_model,
          },
  };
}

export function createDatabaseExternalSourcePersistence(args: {
  userId: string;
  projectId?: string | null;
  db?: ReturnType<typeof createServerSupabase>;
}): ExternalSourcePersistence {
  const db = args.db ?? createServerSupabase();
  const cacheScope = args.projectId
    ? `project:${args.projectId}`
    : `user:${args.userId}`;
  const select =
    "id, source_key, provider, external_id, version_id, title, origin_url, search_tool, read_tool, content_text, content_hash, summary_text, summary_status, summary_model";

  return {
    async storeSource(source, hash) {
      const contentBytes = Buffer.byteLength(source.text, "utf8");
      const { data: existing, error: findError } = await db
        .from("external_source_cache")
        .select(select)
        .eq("cache_scope", cacheScope)
        .eq("source_key", source.id)
        .eq("version_id", source.versionId)
        .eq("content_hash", hash)
        .maybeSingle();
      if (findError) throw new Error(findError.message);
      if (existing) {
        const cached = fromStoredRow(existing as ExternalSourceRow);
        return { id: cached.cacheRecordId!, summary: cached.summary };
      }

      const { data, error } = await db
        .from("external_source_cache")
        .insert({
          cache_scope: cacheScope,
          owner_user_id: args.userId,
          project_id: args.projectId ?? null,
          source_key: source.id,
          provider: source.provider,
          external_id: source.externalId,
          version_id: source.versionId,
          title: source.title,
          origin_url: source.originUrl ?? null,
          search_tool: source.searchTool,
          read_tool: source.readTool,
          content_text: source.text,
          content_hash: hash,
          content_bytes: contentBytes,
          summary_status: "pending",
        })
        .select("id")
        .single();
      if (error || !data?.id) {
        throw new Error(error?.message ?? "Failed to cache external source");
      }
      return { id: String(data.id), summary: null };
    },

    async storeSummary(id, summary) {
      const { error } = await db
        .from("external_source_cache")
        .update({
          summary_text: summary.text,
          summary_status: summary.status,
          summary_model: summary.model,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("cache_scope", cacheScope);
      if (error) throw new Error(error.message);
    },

    async findSource(id) {
      const base = () =>
        db
          .from("external_source_cache")
          .select(select)
          .eq("cache_scope", cacheScope);
      const byId = await base().eq("id", id).maybeSingle();
      if (byId.error) throw new Error(byId.error.message);
      if (byId.data) return fromStoredRow(byId.data as ExternalSourceRow);

      const byKey = await base()
        .eq("source_key", id)
        .order("retrieved_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (byKey.error) throw new Error(byKey.error.message);
      return byKey.data
        ? fromStoredRow(byKey.data as ExternalSourceRow)
        : null;
    },
  };
}

function accessGuidance(source: ExternalSourceDocument): string {
  return `The complete source text is cached server-side. Use ${source.searchTool} to search it and ${source.readTool} to read the relevant text. Treat this summary as orientation only, not as source evidence.`;
}

function fallbackSummary(source: ExternalSourceDocument): string {
  return `${source.title} was downloaded from ${source.provider} and contains ${source.text.length.toLocaleString("en-US")} characters. An automatic content summary was unavailable.`;
}

function normalizeSummary(
  source: ExternalSourceDocument,
  summary: string,
): string {
  const body = summary.trim() || fallbackSummary(source);
  return `${body}\n\n${accessGuidance(source)}`;
}

export class ExternalSourceCache {
  private readonly entries = new Map<string, CachedExternalSource>();
  private readonly inFlightSummaries = new Map<
    string,
    Promise<ExternalSourceSummary>
  >();
  private readonly inFlightCaches = new Map<
    string,
    Promise<CachedExternalSource>
  >();

  constructor(
    private readonly options: {
      summarizer?: ExternalSourceSummarizer;
      summaryModel?: string;
      persistence?: ExternalSourcePersistence;
    } = {},
  ) {}

  get(id: string): CachedExternalSource | undefined {
    return this.entries.get(id);
  }

  values(): CachedExternalSource[] {
    return Array.from(this.entries.values());
  }

  async resolve(id: string): Promise<CachedExternalSource | undefined> {
    const current = this.entries.get(id);
    if (current) return current;
    const stored = await this.options.persistence?.findSource(id);
    if (!stored) return undefined;
    this.entries.set(stored.source.id, stored);
    if (stored.cacheRecordId) this.entries.set(stored.cacheRecordId, stored);
    return stored;
  }

  cache(source: ExternalSourceDocument): Promise<CachedExternalSource> {
    const hash = contentHash(source.text);
    const current = this.entries.get(source.id);
    if (current?.contentHash === hash && current.summary) {
      return Promise.resolve(current);
    }
    const cacheKey = `${source.id}:${source.versionId}:${hash}`;
    const inFlight = this.inFlightCaches.get(cacheKey);
    if (inFlight) return inFlight;
    const pending = this.storeAndSummarize(source, hash).finally(() => {
      this.inFlightCaches.delete(cacheKey);
    });
    this.inFlightCaches.set(cacheKey, pending);
    return pending;
  }

  private async storeAndSummarize(
    source: ExternalSourceDocument,
    hash: string,
  ): Promise<CachedExternalSource> {
    const stored = this.options.persistence
      ? await this.options.persistence.storeSource(source, hash)
      : undefined;

    // Cache the complete source before starting the optional LLM work. Search,
    // read and verification remain available even if summary generation fails.
    const pendingEntry: CachedExternalSource = {
      cacheRecordId: stored?.id ?? null,
      source,
      contentHash: hash,
      summary: stored?.summary ?? null,
    };
    this.entries.set(source.id, pendingEntry);
    if (stored?.id) this.entries.set(stored.id, pendingEntry);
    if (stored?.summary) return pendingEntry;

    const summaryKey = `${source.id}:${hash}`;
    let summaryPromise = this.inFlightSummaries.get(summaryKey);
    if (!summaryPromise) {
      summaryPromise = this.generateSummary(source).finally(() => {
        this.inFlightSummaries.delete(summaryKey);
      });
      this.inFlightSummaries.set(summaryKey, summaryPromise);
    }

    const summary = await summaryPromise;
    const latest = this.entries.get(source.id);
    if (latest?.contentHash !== hash) return latest ?? pendingEntry;

    const completed = { ...latest, summary };
    this.entries.set(source.id, completed);
    if (completed.cacheRecordId) {
      await this.options.persistence?.storeSummary(
        completed.cacheRecordId,
        summary,
      );
      this.entries.set(completed.cacheRecordId, completed);
    }
    return completed;
  }

  private async generateSummary(
    source: ExternalSourceDocument,
  ): Promise<ExternalSourceSummary> {
    if (!this.options.summarizer) {
      return {
        text: normalizeSummary(source, fallbackSummary(source)),
        status: "fallback",
        model: null,
      };
    }

    try {
      const generated = await this.options.summarizer(source);
      return {
        text: normalizeSummary(source, generated),
        status: generated.trim() ? "generated" : "fallback",
        model: this.options.summaryModel ?? null,
      };
    } catch {
      return {
        text: normalizeSummary(source, fallbackSummary(source)),
        status: "fallback",
        model: this.options.summaryModel ?? null,
      };
    }
  }
}

export function createFastModelExternalSourceSummarizer(args: {
  model: string;
  apiKeys?: UserApiKeys;
}): ExternalSourceSummarizer {
  return async (source) =>
    completeText({
      model: args.model,
      apiKeys: args.apiKeys,
      maxTokens: 400,
      systemPrompt:
        "Summarize a downloaded external source for an AI agent's orientation. Identify the document's subject, structure, major issues, and where likely-relevant material appears. Be concise and neutral. Do not present the summary as evidence, do not invent details, and do not give instructions about tools.",
      user: `Title: ${source.title}\nProvider: ${source.provider}\n\nSOURCE TEXT:\n${source.text}`,
    });
}
