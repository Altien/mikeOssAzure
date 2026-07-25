import { describe, expect, it } from "vitest";
import {
  verificationProposalSchema,
  verifiedRecordSchema,
} from "./schemas";

function proposal() {
  return {
    schema_version: 1,
    memo: { document_id: "doc-0" },
    sources: {
      authority: {
        document_id: "doc-1",
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
        anchors_proposed: [
          {
            source: "authority",
            quote: "The court adopted the rule.",
          },
        ],
      },
    ],
  };
}

describe("verificationProposalSchema", () => {
  it("accepts one memo, one source, and one exact passage proposal", () => {
    expect(verificationProposalSchema.parse(proposal())).toEqual(proposal());
  });

  it("rejects duplicate citation ids before verification starts", () => {
    const input = proposal();
    input.citations.push({ ...input.citations[0] });

    expect(() => verificationProposalSchema.parse(input)).toThrow(
      /duplicate citation id/i,
    );
  });

  it("rejects citations that reference an undeclared source", () => {
    const input = proposal();
    input.citations[0].source_candidates = ["missing"];

    expect(() => verificationProposalSchema.parse(input)).toThrow(
      /unknown source/i,
    );
  });

  it("accepts source-qualified passages from multiple candidate authorities", () => {
    const input = proposal();
    input.sources.statute = {
      document_id: "doc-2",
      title: "Statute",
      kind: "case",
    };
    input.citations[0].source_candidates.push("statute");
    input.citations[0].anchors_proposed.push({
      source: "statute",
      quote: "The legislature adopted the same rule.",
    });

    expect(verificationProposalSchema.parse(input)).toEqual(input);
  });

  it("rejects a proposed passage whose source is not a candidate", () => {
    const input = proposal();
    input.sources.statute = {
      document_id: "doc-2",
      title: "Statute",
      kind: "case",
    };
    input.citations[0].anchors_proposed[0].source = "statute";

    expect(() => verificationProposalSchema.parse(input)).toThrow(
      /not a candidate/i,
    );
  });
});

describe("verifiedRecordSchema", () => {
  it("rejects an anchor whose offsets cannot contain its quote", () => {
    const parsed = {
      schema_version: 1,
      memo: {
        document_id: "memo-id",
        version_id: "memo-v1",
        filename: "memo.md",
        sha256: "a".repeat(64),
        bytes: 20,
      },
      sources: {
        authority: {
          document_id: "source-id",
          version_id: "source-v1",
          filename: "source.md",
          title: "Authority",
          kind: "case",
          sha256: "b".repeat(64),
          bytes: 40,
        },
      },
      citations: [
        {
          id: "c001",
          source_candidates: ["authority"],
          cite_text: "Example v Example",
          memo_anchor: { start: 0, end: 17 },
          proposition: "The court adopted the rule.",
          support_type: "quotation",
          anchors: [
            {
              source: "authority",
              quote: "The court adopted the rule.",
              start: 10,
              end: 11,
              match: "exact",
            },
          ],
          status: "anchored",
          binds_to: "c".repeat(64),
        },
      ],
    };

    expect(() => verifiedRecordSchema.parse(parsed)).toThrow(
      /anchor span length/i,
    );
  });
});
