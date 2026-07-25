import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalSourceCache } from "../externalSourceCache";

const {
  getCourtlistenerCasesMock,
  searchCourtlistenerCaseLawMock,
  verifyCourtlistenerCitationsMock,
} = vi.hoisted(() => ({
  getCourtlistenerCasesMock: vi.fn(),
  searchCourtlistenerCaseLawMock: vi.fn(),
  verifyCourtlistenerCitationsMock: vi.fn(),
}));

vi.mock("../../courtlistener", () => ({
  getCourtlistenerCases: getCourtlistenerCasesMock,
  searchCourtlistenerCaseLaw: searchCourtlistenerCaseLawMock,
  verifyCourtlistenerCitations: verifyCourtlistenerCitationsMock,
}));

import { runToolCalls } from "./toolDispatcher";

beforeEach(() => {
  getCourtlistenerCasesMock.mockReset();
  searchCourtlistenerCaseLawMock.mockReset();
  verifyCourtlistenerCitationsMock.mockReset();
});

describe("external source tool dispatch", () => {
  it("caches the complete opinion, summarizes it, and searches the cache", async () => {
    const fullText = `Opening material.${"x".repeat(10_000)} The late holding controls.`;
    getCourtlistenerCasesMock.mockResolvedValue({
      cases: [
        {
          clusterId: 123,
          id: 123,
          caseName: "Example v Example",
          citations: ["123 U.S. 456"],
          url: "https://www.courtlistener.com/opinion/123/example/",
          dateFiled: "2020-01-01",
          opinions: [
            {
              opinionId: 456,
              text: fullText,
              url: "https://www.courtlistener.com/opinion/123/example/",
            },
          ],
        },
      ],
    });
    const summarizer = vi
      .fn()
      .mockResolvedValue("A case whose controlling discussion appears late.");
    const courtState = {
      casesByClusterId: new Map(),
      verificationArtifacts: new Map(),
    };
    const externalSources = new ExternalSourceCache({
      summarizer,
      summaryModel: "cheap-fast-model",
    });

    const sourceId = "courtlistener:cluster:123:opinion:456";
    const result = await runToolCalls(
      [
        {
          id: "get-1",
          function: {
            name: "courtlistener_get_cases",
            arguments: JSON.stringify({ clusterIds: [123] }),
          },
        },
        {
          id: "find-1",
          function: {
            name: "search_external_source",
            arguments: JSON.stringify({
              external_source_id: sourceId,
              query: "late holding",
            }),
          },
        },
        {
          id: "read-1",
          function: {
            name: "read_external_source",
            arguments: JSON.stringify({
              external_source_id: sourceId,
              start: fullText.length - 50,
              max_chars: 500,
            }),
          },
        },
      ],
      new Map(),
      "user-1",
      {} as never,
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      null,
      courtState,
      { courtlistener: "test-token" },
      externalSources,
    );

    expect(getCourtlistenerCasesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        clusterIds: [123],
        includeFullText: true,
      }),
    );
    expect(summarizer).toHaveBeenCalledTimes(1);

    const getPayload = JSON.parse(
      String((result.toolResults[0] as { content: string }).content),
    );
    expect(getPayload.cases[0].opinions[0]).toMatchObject({
      opinion_id: 456,
      char_count: fullText.length,
      external_source_id: sourceId,
      summary_status: "generated",
      summary_model: "cheap-fast-model",
    });
    expect(getPayload.cases[0].opinions[0].summary).toContain(
      "Use search_external_source to search it",
    );

    expect(externalSources.get(sourceId)?.source.text).toBe(fullText);

    const findPayload = JSON.parse(
      String((result.toolResults[1] as { content: string }).content),
    );
    expect(findPayload).toMatchObject({
      total_matches: 1,
      returned: 1,
    });
    expect(findPayload.hits[0]).toMatchObject({
      excerpt: "late holding",
    });
    expect(findPayload.verification_source_id).toBe(sourceId);

    const readPayload = JSON.parse(
      String((result.toolResults[2] as { content: string }).content),
    );
    expect(readPayload).toMatchObject({
      external_source_id: sourceId,
      verification_source_id: sourceId,
      total_chars: fullText.length,
    });
    expect(readPayload.text).toContain("late holding");
    expect(
      (
        courtState.verificationArtifacts.get(sourceId) as
          | { text?: string }
          | undefined
      )?.text,
    ).toBe(fullText);
  });
});
