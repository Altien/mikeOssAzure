import { describe, expect, it, vi } from "vitest";
import {
  ExternalSourceCache,
  type CachedExternalSource,
  type ExternalSourceDocument,
  type ExternalSourceSummary,
} from "./externalSourceCache";

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
    const summarizer = vi.fn().mockResolvedValue(
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
      async storeSummary(
        id: string,
        summary: ExternalSourceSummary,
      ) {
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
