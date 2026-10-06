import { describe, expect, it } from "vitest";
// Dev drift: #295 moved this file into modules/chat/engine/tools; path re-rooted.
import type { ExternalSourceCache } from "../../../../altien/externalSources/cache";
import {
  getCachedCaseOpinionTexts,
  courtlistenerFetchedCaseMetadata,
  upsertCourtlistenerCases,
  type CourtlistenerTurnState,
} from "./courtlistenerTurnState";

describe("CourtListener turn state", () => {
  it("retains cached source text and summary identity after helper extraction", () => {
    const state: CourtlistenerTurnState = { casesByClusterId: new Map(), verificationArtifacts: new Map() };
    const [record] = upsertCourtlistenerCases(state, [{ clusterId: 123, opinions: [{ opinionId: 7, text: "Partial" }] }]);
    const cached = { source: { id: "courtlistener:cluster:123:opinion:7", text: "Complete cached opinion" }, cacheRecordId: "stored-source", summary: { text: "Summary", status: "ready", model: "fast" } };
    const cache = { get: (id: string) => id === cached.source.id ? cached : undefined } as unknown as ExternalSourceCache;
    expect(getCachedCaseOpinionTexts(state, 123, cache)[0].text).toBe("Complete cached opinion");
    expect(courtlistenerFetchedCaseMetadata(record, 1, cache).opinions[0]).toMatchObject({ external_source_id: "stored-source", summary: "Summary", summary_model: "fast", char_count: 23 });
  });
  it("uses the freshest non-empty opinion payload", () => {
    const state: CourtlistenerTurnState = { casesByClusterId: new Map(), verificationArtifacts: new Map() };
    upsertCourtlistenerCases(state, [
      {
        clusterId: 123,
        opinions: [{ opinionId: 1, text: "Partial text" }],
      },
    ]);
    upsertCourtlistenerCases(state, [
      {
        clusterId: 123,
        opinions: [{ opinionId: 1, text: "Complete opinion text" }],
      },
    ]);

    expect(getCachedCaseOpinionTexts(state, 123)).toMatchObject([
      { opinion_id: 1, text: "Complete opinion text" },
    ]);
  });

  it("normalizes HTML into text for citation verification", () => {
    const state: CourtlistenerTurnState = { casesByClusterId: new Map(), verificationArtifacts: new Map() };
    upsertCourtlistenerCases(state, [
      {
        clusterId: 456,
        opinions: [
          {
            opinionId: 2,
            html: "<p>The Court <strong>affirms</strong>.</p>",
          },
        ],
      },
    ]);

    expect(getCachedCaseOpinionTexts(state, 456)[0]?.text).toBe(
      "The Court affirms.",
    );
  });

  it("skips malformed script tags without double-decoding entities", () => {
    const state: CourtlistenerTurnState = { casesByClusterId: new Map(), verificationArtifacts: new Map() };
    upsertCourtlistenerCases(state, [
      {
        clusterId: 789,
        opinions: [
          {
            opinionId: 3,
            html: [
              "<script>alert('unsafe')</script >",
              "<p>Decision &amp; Costs</p>",
              "<p>&amp;lt;script&amp;gt;</p>",
            ].join(""),
          },
        ],
      },
    ]);

    const text = getCachedCaseOpinionTexts(state, 789)[0]?.text;
    expect(text).toBe("Decision & Costs &lt;script&gt;");
    expect(text).not.toContain("unsafe");
    expect(text).not.toContain("<script>");
  });
});
