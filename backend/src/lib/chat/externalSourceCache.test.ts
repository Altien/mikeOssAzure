import { describe, expect, it, vi } from "vitest";
import {
  ExternalSourceCache,
  type ExternalSourceDocument,
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
});
