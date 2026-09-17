import { createHash, randomUUID } from "node:crypto";
import { completeText, type UserApiKeys } from "../../lib/llm";
import { createServerSupabase } from "../../lib/supabase";
import { createDocumentVersion } from "../../modules/documents/documents.service";
import {
  deleteFile,
  downloadFile,
  externalSourceStorageKey,
  uploadFile,
} from "../../lib/storage";

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
  storeSummary(id: string, summary: ExternalSourceSummary): Promise<void>;
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
  content_hash: string;
  content_bytes: number;
  document_id: string | null;
  document_version_id: string | null;
  summary_text: string | null;
  summary_status: "pending" | "generated" | "fallback";
  summary_model: string | null;
};

const EXTERNAL_PROVENANCE_OWNER = "system:external-provenance";

function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fromStoredRow(
  row: ExternalSourceRow,
  text: string,
): CachedExternalSource {
  return {
    cacheRecordId: row.id,
    source: {
      id: row.source_key,
      provider: row.provider,
      externalId: row.external_id,
      versionId: row.version_id,
      title: row.title,
      text,
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

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function safeFilename(title: string): string {
  const stem =
    title
      .trim()
      .replace(/[\x00-\x1f\x7f/\\]/g, "_")
      .slice(0, 180) || "external-source";
  return `${stem}.txt`;
}

function provenanceKey(provider: string): string {
  return (
    provider
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "external"
  );
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
    "id, source_key, provider, external_id, version_id, title, origin_url, search_tool, read_tool, content_hash, content_bytes, document_id, document_version_id, summary_text, summary_status, summary_model";

  async function findRow(id: string): Promise<ExternalSourceRow | null> {
    const base = () =>
      db
        .from("external_source_cache")
        .select(select)
        .eq("cache_scope", cacheScope);
    const byId = await base().eq("id", id).maybeSingle();
    if (byId.error) throw new Error(byId.error.message);
    if (byId.data) return byId.data as ExternalSourceRow;

    const byKey = await base()
      .eq("source_key", id)
      .order("retrieved_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (byKey.error) throw new Error(byKey.error.message);
    return (byKey.data as ExternalSourceRow | null) ?? null;
  }

  async function findReusableRow(
    source: ExternalSourceDocument,
    hash: string,
  ): Promise<ExternalSourceRow | null> {
    const { data, error } = await db
      .from("external_source_cache")
      .select(select)
      .eq("source_key", source.id)
      .eq("version_id", source.versionId)
      .eq("content_hash", hash)
      .order("retrieved_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as ExternalSourceRow | null) ?? null;
  }

  async function ensureProvenanceProject(provider: string): Promise<string> {
    const key = provenanceKey(provider);
    const find = () =>
      db
        .from("projects")
        .select("id")
        .eq("project_kind", "external_provenance")
        .eq("provenance_key", key)
        .maybeSingle();
    const existing = await find();
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data?.id) return String(existing.data.id);

    const { data, error } = await db
      .from("projects")
      .insert({
        user_id: EXTERNAL_PROVENANCE_OWNER,
        name: `${provider.trim() || "External"} sources`,
        visibility: "private",
        project_kind: "external_provenance",
        provenance_key: key,
      })
      .select("id")
      .single();
    if (!error && data?.id) return String(data.id);

    // A concurrent request may have won the unique-key race.
    const concurrent = await find();
    if (concurrent.error || !concurrent.data?.id) {
      throw new Error(
        error?.message ??
          concurrent.error?.message ??
          "Failed to create provenance project",
      );
    }
    return String(concurrent.data.id);
  }

  async function createDmsDocument(source: ExternalSourceDocument): Promise<{
    documentId: string;
    documentVersionId: string;
    storagePath: string;
  }> {
    const provenanceProjectId = await ensureProvenanceProject(source.provider);
    const documentId = randomUUID();
    const documentVersionId = randomUUID();
    const bytes = new TextEncoder().encode(source.text);
    const storagePath = externalSourceStorageKey(
      EXTERNAL_PROVENANCE_OWNER,
      documentId,
      documentVersionId,
    );
    await uploadFile(
      storagePath,
      exactArrayBuffer(bytes),
      "text/plain; charset=utf-8",
    );

    let documentInserted = false;
    try {
      const { error: documentError } = await db.from("documents").insert({
        id: documentId,
        project_id: provenanceProjectId,
        user_id: EXTERNAL_PROVENANCE_OWNER,
        status: "processing",
      });
      if (documentError) throw new Error(documentError.message);
      documentInserted = true;

      const { error: versionError } = await createDocumentVersion(db, {
          id: documentVersionId,
          document_id: documentId,
          storage_path: storagePath,
          pdf_storage_path: null,
          source: "external_retrieval",
          version_number: 1,
          filename: safeFilename(source.title),
          file_type: "txt",
          size_bytes: bytes.byteLength,
      });
      if (versionError) throw new Error(versionError.message);

      const { error: readyError } = await db
        .from("documents")
        .update({
          current_version_id: documentVersionId,
          status: "ready",
          updated_at: new Date().toISOString(),
        })
        .eq("id", documentId);
      if (readyError) throw new Error(readyError.message);
      return { documentId, documentVersionId, storagePath };
    } catch (error) {
      if (documentInserted) {
        await db.from("documents").delete().eq("id", documentId);
      }
      await deleteFile(storagePath).catch(() => {});
      throw error;
    }
  }

  async function removeDmsDocument(documentId: string, storagePath: string) {
    await db.from("documents").delete().eq("id", documentId);
    await deleteFile(storagePath).catch(() => {});
  }

  function requireDmsBacking(row: ExternalSourceRow): ExternalSourceRow & {
    document_id: string;
    document_version_id: string;
  } {
    if (!row.document_id || !row.document_version_id) {
      throw new Error(`External source has no DMS document version: ${row.id}`);
    }
    return row as ExternalSourceRow & {
      document_id: string;
      document_version_id: string;
    };
  }

  async function readRowText(row: ExternalSourceRow): Promise<string> {
    const materialized = requireDmsBacking(row);
    const { data, error } = await db
      .from("document_versions")
      .select("id, document_id, storage_path")
      .eq("id", materialized.document_version_id!)
      .eq("document_id", materialized.document_id!)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data?.storage_path) {
      throw new Error(`External source document is unavailable: ${row.id}`);
    }
    const raw = await downloadFile(String(data.storage_path));
    if (!raw) {
      throw new Error(`External source blob is unavailable: ${row.id}`);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    if (contentHash(text) !== row.content_hash) {
      throw new Error(`External source integrity check failed: ${row.id}`);
    }
    return text;
  }

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
        const row = requireDmsBacking(existing as ExternalSourceRow);
        const cached = fromStoredRow(row, source.text);
        return { id: cached.cacheRecordId!, summary: cached.summary };
      }

      const reusable = await findReusableRow(source, hash);
      const reusedRow = reusable ? requireDmsBacking(reusable) : null;
      const createdDms = reusedRow ? null : await createDmsDocument(source);
      const documentId = reusedRow?.document_id ?? createdDms!.documentId;
      const documentVersionId =
        reusedRow?.document_version_id ?? createdDms!.documentVersionId;
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
          content_hash: hash,
          content_bytes: contentBytes,
          document_id: documentId,
          document_version_id: documentVersionId,
          summary_text: reusedRow?.summary_text ?? null,
          summary_status: reusedRow?.summary_status ?? "pending",
          summary_model: reusedRow?.summary_model ?? null,
        })
        .select("id")
        .single();
      if (error || !data?.id) {
        if (createdDms) {
          await removeDmsDocument(
            createdDms.documentId,
            createdDms.storagePath,
          );
        }
        const concurrent = await findRow(source.id);
        if (
          concurrent?.version_id === source.versionId &&
          concurrent.content_hash === hash
        ) {
          return {
            id: concurrent.id,
            summary:
              concurrent.summary_status === "pending" ||
              !concurrent.summary_text
                ? null
                : {
                    text: concurrent.summary_text,
                    status: concurrent.summary_status,
                    model: concurrent.summary_model,
                  },
          };
        }
        throw new Error(error?.message ?? "Failed to cache external source");
      }
      return {
        id: String(data.id),
        summary:
          reusedRow?.summary_status === "pending" || !reusedRow?.summary_text
            ? null
            : {
                text: reusedRow.summary_text,
                status: reusedRow.summary_status,
                model: reusedRow.summary_model,
              },
      };
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
      const row = await findRow(id);
      if (!row) return null;
      return fromStoredRow(row, await readRowText(row));
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
