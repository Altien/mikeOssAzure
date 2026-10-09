import { afterEach, describe, expect, it, vi } from "vitest";
import { getCourtlistenerCaseOpinions } from "../../lib/courtlistener";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function stubOpinionResponse(text: string) {
  vi.stubEnv("COURTLISTENER_BULK_DATA_ENABLED", "false");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          next: null,
          results: [
            {
              id: 456,
              cluster: 123,
              plain_text: text,
              absolute_url: "/opinion/123/example-v-example/",
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    ),
  );
}

describe("CourtListener opinion retrieval", () => {
  it("keeps complete opinion text when full text is requested", async () => {
    const fullText = `Opening.${"x".repeat(70_000)}Late holding.`;
    stubOpinionResponse(fullText);

    const result = await getCourtlistenerCaseOpinions({
      clusterId: 123,
      includeFullText: true,
      maxChars: 50_000,
      apiToken: "test-token",
    });

    // Dev drift: typecheck:test (upstream #295) — the result is a union
    // (error / bulk / opinions); read opinions through a narrowed view.
    const opinions = (result as { opinions?: Array<{ text?: string }> }).opinions;
    expect(opinions?.[0]?.text).toBe(fullText);
    expect(opinions?.[0]?.text).toContain("Late holding.");
  });

  it("retains the small preview for callers that do not request full text", async () => {
    const fullText = `Opening.${"x".repeat(10_000)}Late holding.`;
    stubOpinionResponse(fullText);

    const result = await getCourtlistenerCaseOpinions({
      clusterId: 123,
      apiToken: "test-token",
    });

    const opinions = (result as { opinions?: Array<{ text?: string }> }).opinions;
    expect(opinions?.[0]?.text).toHaveLength(3_000);
    expect(opinions?.[0]?.text).toMatch(/…$/);
    expect(opinions?.[0]?.text).not.toContain("Late holding.");
  });
});
