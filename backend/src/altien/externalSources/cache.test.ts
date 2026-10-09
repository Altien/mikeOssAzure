import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { makeFakeDb, type DbCall } from "../../test/helpers/fakeDb";

const { uploadFileMock, downloadFileMock, deleteFileMock } = vi.hoisted(() => ({
  uploadFileMock: vi.fn(),
  downloadFileMock: vi.fn(),
  deleteFileMock: vi.fn(),
}));
vi.mock("../../lib/storage", () => ({
  uploadFile: uploadFileMock,
  downloadFile: downloadFileMock,
  deleteFile: deleteFileMock,
  externalSourceStorageKey: (
    userId: string,
    documentId: string,
    versionId: string,
  ) => `documents/${userId}/${documentId}/versions/${versionId}.txt`,
}));

import {
  createDatabaseExternalSourcePersistence,
  ExternalSourceCache,
  type CachedExternalSource,
  type ExternalSourceDocument,
  type ExternalSourceSummary,
} from "./cache";

const source: ExternalSourceDocument = {
  id: "courtlistener:cluster:123:opinion:456",
  provider: "CourtListener",
  externalId: "456",
  versionId: "opinion-456",
  title: "Example v Example",
  text: `Opening material.${"x".repeat(10_000)}Late controlling passage.`,
  originUrl: "https://example.test/opinion/456",
  searchTool: "courtlistener_find_in_case",
  readTool: "courtlistener_read_case",
};

describe("ExternalSourceCache", () => {
  it("caches complete text and appends search/read guidance to the summary", async () => {
    const summarizer = vi
      .fn()
      .mockResolvedValue(
        "A dispute concerning sanctions, with the holding near the end.",
      );
    const cache = new ExternalSourceCache({
      summarizer,
      summaryModel: "cheap-fast-model",
    });

    const cached = await cache.cache(source);

    expect(cached.source.text).toBe(source.text);
    expect(cached.source.text).toContain("Late controlling passage.");
    expect(cached.summary).toMatchObject({
      status: "generated",
      model: "cheap-fast-model",
    });
    expect(cached.summary?.text).toContain(
      "Use courtlistener_find_in_case to search it and courtlistener_read_case to read",
    );
    expect(cached.summary?.text).toContain("orientation only");
  });

  it("coalesces duplicate summary work for the same source version", async () => {
    let resolveSummary: ((value: string) => void) | undefined;
    const summarizer = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveSummary = resolve;
        }),
    );
    const cache = new ExternalSourceCache({ summarizer });

    const first = cache.cache(source);
    const second = cache.cache(source);
    resolveSummary?.("One cached summary.");
    await Promise.all([first, second]);

    expect(summarizer).toHaveBeenCalledTimes(1);
  });

  it("keeps the source usable when the summary model fails", async () => {
    const cache = new ExternalSourceCache({
      summarizer: vi.fn().mockRejectedValue(new Error("model unavailable")),
      summaryModel: "cheap-fast-model",
    });

    const cached = await cache.cache(source);

    expect(cached.source.text).toBe(source.text);
    expect(cached.summary).toMatchObject({
      status: "fallback",
      model: "cheap-fast-model",
    });
    expect(cached.summary?.text).toContain(
      "automatic content summary was unavailable",
    );
    expect(cached.summary?.text).toContain(
      "Use courtlistener_find_in_case to search it",
    );
  });

  it("persists exact text before the summary and resolves it in later turns", async () => {
    const stored = new Map<string, CachedExternalSource>();
    const calls: string[] = [];
    const persistence = {
      async storeSource(document: ExternalSourceDocument, hash: string) {
        calls.push("source");
        const cached = {
          cacheRecordId: "cache-row-1",
          source: document,
          contentHash: hash,
          summary: null,
        };
        stored.set("cache-row-1", cached);
        return { id: "cache-row-1", summary: null };
      },
      async storeSummary(id: string, summary: ExternalSourceSummary) {
        calls.push("summary");
        const cached = stored.get(id);
        if (cached) stored.set(id, { ...cached, summary });
      },
      async findSource(id: string) {
        calls.push("resolve");
        return stored.get(id) ?? null;
      },
    };
    const firstTurn = new ExternalSourceCache({
      persistence,
      summarizer: vi.fn().mockResolvedValue("Durable orientation."),
    });

    const cached = await firstTurn.cache(source);
    expect(cached.cacheRecordId).toBe("cache-row-1");
    expect(calls.slice(0, 2)).toEqual(["source", "summary"]);

    const laterTurn = new ExternalSourceCache({ persistence });
    const resolved = await laterTurn.resolve("cache-row-1");
    expect(resolved?.source.text).toBe(source.text);
    expect(resolved?.summary?.text).toContain("Durable orientation.");
    expect(calls.at(-1)).toBe("resolve");
  });
});

describe("database external-source persistence", () => {
  it("stores new external text as a normal document in a provenance project", async () => {
    uploadFileMock.mockReset().mockResolvedValue(undefined);
    deleteFileMock.mockReset().mockResolvedValue(undefined);
    const respond = (call: DbCall) => {
      if (call.table === "projects" && call.op === "select") {
        return { data: [] };
      }
      if (call.table === "projects" && call.op === "insert") {
        return { data: [{ id: "provenance-project" }] };
      }
      if (call.table === "external_source_cache" && call.op === "select") {
        return { data: [] };
      }
      if (call.table === "external_source_cache" && call.op === "insert") {
        return { data: [{ id: "cache-row-1" }] };
      }
      return { data: [] };
    };
    const { db, callsFor } = makeFakeDb(respond);
    const persistence = createDatabaseExternalSourcePersistence({
      userId: "user-1",
      projectId: "matter-1",
      db: db as never,
    });
    const hash = createHash("sha256").update(source.text).digest("hex");

    const result = await persistence.storeSource(source, hash);

    expect(result.id).toBe("cache-row-1");
    expect(uploadFileMock).toHaveBeenCalledWith(
      expect.stringMatching(
        /^documents\/system:external-provenance\/[^/]+\/versions\/[^/]+\.txt$/,
      ),
      expect.any(ArrayBuffer),
      "text/plain; charset=utf-8",
    );
    expect(callsFor("projects", "insert")[0]?.payload).toMatchObject({
      user_id: "system:external-provenance",
      project_kind: "external_provenance",
      provenance_key: "courtlistener",
    });
    expect(callsFor("documents", "insert")[0]?.payload).toMatchObject({
      project_id: "provenance-project",
      user_id: "system:external-provenance",
    });
    // Dev drift: upstream #295 writes versions through the documents
    // lifecycle facade (create_document_version RPC, row in p_version).
    expect(
      (callsFor("create_document_version", "rpc")[0]?.payload as
        | { p_version?: unknown }
        | undefined)?.p_version,
    ).toMatchObject({
      source: "external_retrieval",
      version_number: 1,
      file_type: "txt",
    });
    expect(
      callsFor("external_source_cache", "insert")[0]?.payload,
    ).toMatchObject({
      project_id: "matter-1",
      content_hash: hash,
      document_id: expect.any(String),
      document_version_id: expect.any(String),
    });
  });

  it("resolves later turns from the linked document version blob", async () => {
    const hash = createHash("sha256").update(source.text).digest("hex");
    downloadFileMock
      .mockReset()
      .mockResolvedValue(new TextEncoder().encode(source.text).buffer);
    const { db } = makeFakeDb((call) => {
      if (call.table === "external_source_cache") {
        return {
          data: [
            {
              id: "cache-row-1",
              source_key: source.id,
              provider: source.provider,
              external_id: source.externalId,
              version_id: source.versionId,
              title: source.title,
              origin_url: source.originUrl,
              search_tool: source.searchTool,
              read_tool: source.readTool,
              content_hash: hash,
              content_bytes: Buffer.byteLength(source.text),
              document_id: "document-1",
              document_version_id: "document-version-1",
              summary_text: "A stored summary.",
              summary_status: "generated",
              summary_model: "fast-model",
            },
          ],
        };
      }
      if (call.table === "document_versions") {
        return {
          data: [
            {
              id: "document-version-1",
              document_id: "document-1",
              storage_path:
                "documents/system:external-provenance/document-1/versions/v1.txt",
            },
          ],
        };
      }
      return { data: [] };
    });
    const persistence = createDatabaseExternalSourcePersistence({
      userId: "user-1",
      projectId: "matter-1",
      db: db as never,
    });

    const resolved = await persistence.findSource("cache-row-1");

    expect(resolved?.source.text).toBe(source.text);
    expect(resolved?.summary?.text).toBe("A stored summary.");
    expect(downloadFileMock).toHaveBeenCalledWith(
      "documents/system:external-provenance/document-1/versions/v1.txt",
    );
  });

  it("reuses one provenance document across users and matter scopes", async () => {
    uploadFileMock.mockReset().mockResolvedValue(undefined);
    const hash = createHash("sha256").update(source.text).digest("hex");
    const reusable = {
      id: "cache-row-old-matter",
      source_key: source.id,
      provider: source.provider,
      external_id: source.externalId,
      version_id: source.versionId,
      title: source.title,
      origin_url: source.originUrl,
      search_tool: source.searchTool,
      read_tool: source.readTool,
      content_hash: hash,
      content_bytes: Buffer.byteLength(source.text),
      document_id: "shared-document",
      document_version_id: "shared-version",
      summary_text: "Reusable orientation.",
      summary_status: "generated",
      summary_model: "fast-model",
    };
    const { db, callsFor } = makeFakeDb((call) => {
      if (
        call.table === "external_source_cache" &&
        call.op === "select" &&
        call.filters.some(
          ([method, column]) => method === "eq" && column === "cache_scope",
        )
      ) {
        return { data: [] };
      }
      if (call.table === "external_source_cache" && call.op === "select") {
        return { data: [reusable] };
      }
      if (call.table === "external_source_cache" && call.op === "insert") {
        return { data: [{ id: "cache-row-new-matter" }] };
      }
      return { data: [] };
    });
    const persistence = createDatabaseExternalSourcePersistence({
      userId: "user-2",
      projectId: "matter-2",
      db: db as never,
    });

    const stored = await persistence.storeSource(source, hash);

    expect(stored).toMatchObject({
      id: "cache-row-new-matter",
      summary: { text: "Reusable orientation." },
    });
    expect(uploadFileMock).not.toHaveBeenCalled();
    expect(callsFor("documents")).toHaveLength(0);
    expect(
      callsFor("external_source_cache", "insert")[0]?.payload,
    ).toMatchObject({
      project_id: "matter-2",
      document_id: "shared-document",
      document_version_id: "shared-version",
    });
  });
});
