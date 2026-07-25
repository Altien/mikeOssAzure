import { describe, expect, it } from "vitest";
import { verificationProposalSchema } from "./schemas";
import { verifyResolvedProposal } from "./verify";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function input(overrides?: {
  memo?: string;
  source?: string;
  quote?: string;
}) {
  const memo =
    overrides?.memo ?? "The rule applies. Example v Example confirms this.";
  const source =
    overrides?.source ?? "Background.\nThe court adopted the rule.\nEnd.";
  const quote = overrides?.quote ?? "The court adopted the rule.";
  const proposal = verificationProposalSchema.parse({
    schema_version: 1,
    memo: { document_id: "memo-id", version_id: "memo-v1" },
    sources: {
      authority: {
        document_id: "source-id",
        version_id: "source-v1",
        title: "Authority",
        kind: "case",
      },
    },
    citations: [
      {
        id: "c001",
        source_candidates: ["authority"],
        cite_text: "Example v Example",
        proposition: "The court adopted the rule.",
        support_type: "quotation",
        anchors_proposed: [{ source: "authority", quote }],
      },
    ],
  });
  return {
    proposal,
    memo: {
      documentId: "memo-id",
      versionId: "memo-v1",
      filename: "memo.md",
      bytes: bytes(memo),
    },
    sources: {
      authority: {
        documentId: "source-id",
        versionId: "source-v1",
        filename: "authority.md",
        bytes: bytes(source),
      },
    },
  };
}

describe("verifyResolvedProposal", () => {
  it("anchors an exact quote and records storage-derived hashes and sizes", () => {
    const result = verifyResolvedProposal(input());
    const citation = result.record.citations[0];
    const source = result.record.sources.authority;

    expect(result.report).toMatchObject({
      outcome: "success",
      total: 1,
      anchored: 1,
      failed: 0,
      exact: 1,
      formatting_different: 0,
      no_quote_claimed: 0,
    });
    expect(citation.status).toBe("anchored");
    expect(citation.anchors).toHaveLength(1);
    expect(citation.anchors[0].source).toBe("authority");
    expect(source.bytes).toBe(
      bytes("Background.\nThe court adopted the rule.\nEnd.").byteLength,
    );
    expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("anchors passages from multiple candidate sources", () => {
    const value = input();
    value.proposal.sources.statute = {
      document_id: "statute-id",
      version_id: "statute-v1",
      title: "Statute",
      kind: "statute",
    };
    value.proposal.citations[0].source_candidates.push("statute");
    value.proposal.citations[0].anchors_proposed.push({
      source: "statute",
      quote: "The statute supplies a second basis.",
    });
    value.sources.statute = {
      documentId: "statute-id",
      versionId: "statute-v1",
      filename: "statute.md",
      bytes: bytes("The statute supplies a second basis."),
    };

    const result = verifyResolvedProposal(value);

    expect(result.record.citations[0].anchors.map((anchor) => anchor.source))
      .toEqual(["authority", "statute"]);
    expect(result.report.outcome).toBe("success");
  });

  it("uses JavaScript UTF-16 offsets and still round-trips after an astral character", () => {
    const source = "😀 preface — The court adopted the rule.";
    const result = verifyResolvedProposal(input({ source }));
    const anchor = result.record.citations[0].anchors[0];

    expect(anchor.start).toBe(source.indexOf(anchor.quote));
    expect(anchor.start).toBeGreaterThan(Array.from(source).indexOf("T"));
    expect(source.slice(anchor.start, anchor.end)).toBe(anchor.quote);
  });

  it("distinguishes an absent source passage from a missing memo citation", () => {
    const result = verifyResolvedProposal(
      input({ quote: "The court said something else." }),
    );

    expect(result.report).toMatchObject({
      outcome: "completed_with_failures",
      total: 1,
      anchored: 0,
      failed: 1,
    });
    expect(result.record.citations[0]).toMatchObject({
      status: "anchor_failed",
      failure_reason: "not_found",
      anchors: [],
    });

    const missingMemoCitation = verifyResolvedProposal(
      input({ memo: "The rule applies without a citation." }),
    );
    expect(missingMemoCitation.record.citations[0]).toMatchObject({
      status: "anchor_failed",
      failure_reason: "not_found",
    });
    expect(missingMemoCitation.report.failures[0].reason).toBe(
      "not_found",
    );
  });

  it("records normalized and hyphenless matches with exact raw spans", () => {
    const normalized = verifyResolvedProposal(
      input({
        memo: "Example v Example confirms this.",
        source: "The court “adopted”\r\nthe rule.",
        quote: 'The court "adopted" the rule.',
      }),
    );
    const anchor = normalized.record.citations[0].anchors[0];
    expect(anchor).toMatchObject({
      match: "normalized",
      quote: "The court “adopted”\r\nthe rule.",
    });
    expect(normalized.report.formatting_different).toBe(1);

    const withoutHyphen = verifyResolvedProposal(
      input({
        source: "The court adopted the long-term rule.",
        quote: "The court adopted the longterm rule.",
      }),
    );
    expect(withoutHyphen.record.citations[0].anchors[0]).toMatchObject({
      match: "hyphenless",
      quote: "The court adopted the long-term rule.",
    });
  });

  it("requires unique context for repeated memo citations", () => {
    const repeated = input({
      memo: "First Example v Example. Second Example v Example.",
    });
    let result = verifyResolvedProposal(repeated);
    expect(result.record.citations[0]).toMatchObject({
      status: "anchor_failed",
      failure_reason: "ambiguous_in_memo",
    });

    repeated.proposal.citations[0].memo_context =
      "Second Example v Example.";
    result = verifyResolvedProposal(repeated);
    expect(result.record.citations[0].status).toBe("anchored");
    expect(result.record.citations[0].memo_anchor?.quote).toBe(
      "Example v Example",
    );
    expect(result.record.citations[0].memo_anchor?.start).toBe(
      repeated.memo.bytes.length -
        new TextEncoder().encode("Example v Example.").length,
    );
  });

  it("retains a citation that claims no source quote", () => {
    const value = input();
    value.proposal.citations[0].anchors_proposed = [];

    const result = verifyResolvedProposal(value);

    expect(result.record.citations[0]).toMatchObject({
      status: "no_quote_claimed",
      anchors: [],
      anchor_diagnostics: [],
    });
    expect(result.report).toMatchObject({
      outcome: "success",
      anchored: 0,
      failed: 0,
      no_quote_claimed: 1,
    });
  });

  it("reports warnings and source diagnostics without hiding the citation", () => {
    const result = verifyResolvedProposal(
      input({
        source:
          "The court adopted the rule.\n\nLater, The court adopted the rule.",
      }),
    );

    expect(result.record.citations[0].warnings).toEqual(
      expect.arrayContaining(["multiple_matches", "source_header_match"]),
    );
    expect(result.record.citations[0].anchor_diagnostics[0]).toMatchObject({
      status: "anchored",
      match: "exact",
      anchor_count: 1,
    });
    expect(result.report.warnings.length).toBeGreaterThan(0);
  });

  it("rejects invalid UTF-8 rather than hashing replacement text", () => {
    const value = input();
    value.sources.authority.bytes = Uint8Array.from([0xc3, 0x28]);

    expect(() => verifyResolvedProposal(value)).toThrow(/utf-8/i);
  });
});
