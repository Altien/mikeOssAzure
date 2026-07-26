import { describe, expect, it } from "vitest";
import type { AuthorityTraceWorkspace } from "./reviewService";
import {
  buildAuditHtml,
  buildReviewHtml,
  MAX_EMBEDDED_ORIGINAL_BYTES,
  selectOriginalsForEmbedding,
} from "./htmlExports";

function workspace(): AuthorityTraceWorkspace {
  const citation = {
    id: "c001",
    source_candidates: ["authority"],
    cite_text: "Example v Example",
    proposition: "The rule applies.",
    support_type: "quotation" as const,
    status: "anchored" as const,
    binds_to: "a".repeat(64),
    warnings: [],
    memo_anchor: {
      start: 0,
      end: 17,
      quote: "Example v Example",
      match: "exact" as const,
      warnings: [],
    },
    anchors: [
      {
        source: "authority",
        quote: "The rule applies.",
        start: 0,
        end: 17,
        match: "exact" as const,
        proposal_index: 0,
        segment_index: 0,
        warnings: [],
      },
    ],
    anchor_diagnostics: [],
  };
  return {
    id: "run-1",
    project_id: "project-1",
    created_at: "2026-07-25T12:00:00.000Z",
    verified_record: {
      schema_version: 1,
      memo: {
        document_id: "memo-id",
        version_id: "memo-v1",
        filename: "memo.md",
        sha256: "1".repeat(64),
        bytes: 17,
      },
      sources: {
        authority: {
          document_id: "source-id",
          version_id: "source-v1",
          filename: "source.md",
          sha256: "2".repeat(64),
          bytes: 17,
          title: "Authority",
          kind: "case",
        },
      },
      citations: [
        citation,
        {
          ...citation,
          id: "c002",
          cite_text: "Formatted cite",
          binds_to: "b".repeat(64),
          memo_anchor: { ...citation.memo_anchor, match: "normalized" },
        },
        {
          ...citation,
          id: "c003",
          cite_text: "Failed cite",
          binds_to: "c".repeat(64),
          status: "anchor_failed",
          failure_reason: "not_found",
          memo_anchor: null,
          anchors: [],
        },
        {
          ...citation,
          id: "c004",
          cite_text: "No quotation",
          binds_to: "d".repeat(64),
          status: "no_quote_claimed",
          anchors: [],
        },
      ],
    },
    report: {
      outcome: "completed_with_failures",
      total: 4,
      anchored: 2,
      failed: 1,
      no_quote_claimed: 1,
      exact: 1,
      formatting_different: 1,
      warnings: [],
      failures: [],
    },
    memo: {
      document_id: "memo-id",
      version_id: "memo-v1",
      filename: "memo.md",
      available: true,
      integrity: "ok",
      segments: [{ text: "Example v Example", highlights: ["c001"] }],
    },
    sources: {
      authority: {
        document_id: "source-id",
        version_id: "source-v1",
        filename: "source.md",
        title: "Authority",
        kind: "case",
        available: true,
        integrity: "ok",
        segments: [{ text: "The rule applies.", highlights: ["c001"] }],
      },
    },
    reviews: [],
    current_reviews: {},
    integrity: { ok: true, warnings: [] },
  };
}

describe("Authority Trace exports", () => {
  it("escapes HTML and script-breaking JSON payloads", () => {
    const value = workspace();
    value.verified_record.citations[0].cite_text =
      '</script><script>alert("x")</script>\u2028\u2029';
    value.memo.segments = [
      { text: "<img src=x onerror=alert(1)>", highlights: ["c001"] },
    ];

    const html = buildReviewHtml(value);

    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("\\u003c/script>");
    expect(html).toContain("\\u2028\\u2029");
  });

  it("includes every anchor and review state in a printable landscape audit", () => {
    const value = workspace();
    const current = {
      id: "review-current",
      run_id: "run-1",
      citation_id: "c001",
      binds_to: "a".repeat(64),
      verdict: "verified" as const,
      note: null,
      reviewer_user_id: "user-1",
      reviewer_email: null,
      created_at: "2026-07-25T12:00:00.000Z",
      stale: false,
    };
    value.reviews = [
      current,
      {
        ...current,
        id: "review-stale",
        citation_id: "c002",
        binds_to: "f".repeat(64),
        verdict: "rejected",
        stale: true,
      },
    ];
    value.current_reviews = { c001: current };
    const html = buildAuditHtml(value);

    expect(html).toContain("@page { size: letter landscape;");
    expect(html).toContain(">Exact<");
    expect(html).toContain(">Formatting differs<");
    expect(html).toContain(">Failed<");
    expect(html).toContain(">No quote claimed<");
    expect(html).toContain(">verified<");
    expect(html).toContain(">rejected<");
    expect(html.match(/Unreviewed/g)).toHaveLength(3);
  });

  it("marks a forced degraded review prominently without inventing highlights", () => {
    const value = workspace();
    value.integrity = {
      ok: false,
      warnings: [
        {
          scope: "source",
          source: "authority",
          status: "changed",
          message: "Authority changed; highlights are suppressed.",
        },
      ],
    };
    value.sources.authority.integrity = "changed";
    value.sources.authority.segments = [
      { text: "Changed source", highlights: [] },
    ];

    const html = buildReviewHtml(value);

    expect(html).toContain("DEGRADED EXPORT");
    expect(html).toContain(
      '<h3>authority — Authority</h3><div class="text"><span class="muted">No verified passage is available for this document.</span></div>',
    );
    expect(html).not.toContain(">Changed source<");
    expect(html).not.toContain('data-citations="c001">Changed source');
  });

  it("shows focused evidence excerpts instead of full memo and source text", () => {
    const value = workspace();
    value.memo.segments = [
      { text: "memo-before-".repeat(1_000), highlights: [] },
      { text: "Example v Example", highlights: ["c001"] },
      { text: "memo-after-".repeat(1_000), highlights: [] },
    ];
    value.sources.authority.segments = [
      { text: "source-before-".repeat(1_000), highlights: [] },
      { text: "The rule applies.", highlights: ["c001"] },
      { text: "source-after-".repeat(1_000), highlights: [] },
    ];

    const html = buildReviewHtml(value);
    const visibleBody = html.slice(
      html.indexOf("<body>"),
      html.indexOf("<footer>"),
    );

    expect(visibleBody).toContain("Focused evidence excerpts");
    expect(visibleBody).toContain(
      '<mark data-citations="c001">Example v Example</mark>',
    );
    expect(visibleBody).toContain(
      '<mark data-citations="c001">The rule applies.</mark>',
    );
    expect(visibleBody).not.toContain("memo-before-".repeat(200));
    expect(visibleBody).not.toContain("source-after-".repeat(200));
    expect(visibleBody).toContain(
      "Complete immutable text remains embedded in the export data.",
    );
  });

  it("enforces per-file and total original-document caps with reasons", () => {
    const candidates = [
      {
        filename: "too-large.pdf",
        mediaType: "application/pdf",
        bytes: new Uint8Array(MAX_EMBEDDED_ORIGINAL_BYTES + 1),
      },
      ...Array.from({ length: 4 }, (_, index) => ({
        filename: `part-${index}.bin`,
        mediaType: "application/octet-stream",
        bytes: new Uint8Array(4 * 1024 * 1024),
      })),
    ];

    const selected = selectOriginalsForEmbedding(candidates);

    expect(selected[0]).toMatchObject({
      status: "skipped",
      reason: "file_too_large",
    });
    expect(selected.slice(1, 4).every((entry) => entry.status === "embedded"))
      .toBe(true);
    expect(selected[4]).toMatchObject({
      status: "skipped",
      reason: "total_limit",
    });
  });
});
