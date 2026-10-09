import { createHash } from "node:crypto";
import {
  assertAnchorInvariant,
  verificationReportSchema,
  verifiedRecordSchema,
  type VerificationFailureReason,
  type VerificationProposal,
  type VerificationReport,
  type VerificationWarning,
  type VerifiedRecord,
} from "./schemas";
import {
  findPassageMatches,
  findPlainPassageMatches,
  normalizeWithPositions,
  type PassageMatch,
} from "./normalization";

export type ResolvedDocument = {
  documentId: string;
  versionId: string;
  filename: string;
  bytes: Uint8Array;
  text?: string;
  provider?: string;
  originUrl?: string;
};

export type ResolvedVerificationInput = {
  proposal: VerificationProposal;
  memo: ResolvedDocument;
  sources: Record<string, ResolvedDocument>;
};

type CitationProposal = VerificationProposal["citations"][number];

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeUtf8(document: ResolvedDocument): string {
  if (document.text !== undefined) return document.text;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(document.bytes);
  } catch {
    throw new Error(
      `Document ${document.documentId}/${document.versionId} is not valid UTF-8`,
    );
  }
}

function resolvedMetadata(document: ResolvedDocument) {
  return {
    document_id: document.documentId,
    version_id: document.versionId,
    filename: document.filename,
    sha256: sha256(document.bytes),
    bytes: document.bytes.byteLength,
    ...(document.provider ? { provider: document.provider } : {}),
    ...(document.originUrl ? { origin_url: document.originUrl } : {}),
  };
}

function bindingHash(input: {
  sourceCandidates: Array<{
    source: string;
    documentId: string;
    versionId: string;
  }>;
  citeText: string;
  proposition: string;
  supportType: string;
  pin?: string;
  anchors: Array<{ source: string; quote: string }>;
}): string {
  return sha256(
    JSON.stringify([
      input.sourceCandidates,
      input.citeText,
      input.proposition,
      input.supportType,
      input.pin ?? null,
      input.anchors,
    ]),
  );
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function failureHint(
  reason: VerificationFailureReason,
  scope: "memo" | "source",
): string {
  switch (reason) {
    case "case_mismatch":
      return "The text differs only by letter case; copy the source casing or review the proposed passage.";
    case "ambiguous_in_memo":
      return "The citation occurs more than once; provide a unique memo_context around this occurrence.";
    case "memo_context_not_found":
      return "The supplied memo_context was not found in the snapshotted memo version.";
    case "cite_text_not_in_context":
      return "The supplied memo_context does not contain this citation occurrence.";
    case "segment_too_short":
      return "Each passage segment separated by an ellipsis must contain at least eight normalized characters.";
    case "ellipsis_gap_too_large":
      return "The proposed ellipsis skips too much source text; propose closer passages separately.";
    case "ellipsis_out_of_order":
      return "The proposed ellipsis segments occur in a different order in the source.";
    case "source_missing":
      return "The selected source is unavailable in this verification run.";
    case "memo_citation_not_found":
      return "The citation text was not found in the snapshotted memo version.";
    case "source_passage_not_found":
      return "The proposed passage was not found in the snapshotted source version.";
    case "not_found":
    default:
      return scope === "memo"
        ? "The citation text was not found in the snapshotted memo version."
        : "The proposed passage was not found in the snapshotted source version.";
  }
}

function warningHint(warning: VerificationWarning): string {
  switch (warning) {
    case "multiple_matches":
      return "The passage occurs more than once; the first occurrence was anchored.";
    case "short_passage":
      return "This short passage may not uniquely identify the intended source location.";
    case "source_header_match":
      return "The passage occurs near the start of the source and may be title or header text.";
  }
}

function memoAnchor(
  memoText: string,
  citation: CitationProposal,
):
  | {
      anchor: {
        start: number;
        end: number;
        quote: string;
        match: PassageMatch["match"];
        warnings: VerificationWarning[];
      };
    }
  | { reason: VerificationFailureReason } {
  const citationResult = findPlainPassageMatches(
    memoText,
    citation.cite_text,
  );
  if (!citationResult.ok) return { reason: citationResult.reason };
  const memoWarnings = (match: PassageMatch) =>
    match.warnings.filter(
      (warning) => warning !== "source_header_match",
    );

  if (citationResult.matches.length === 1) {
    const match = citationResult.matches[0];
    return {
      anchor: {
        start: match.start,
        end: match.end,
        quote: match.quote,
        match: match.match,
        warnings: memoWarnings(match),
      },
    };
  }

  if (!citation.memo_context) return { reason: "ambiguous_in_memo" };
  const citeInContext = findPlainPassageMatches(
    citation.memo_context,
    citation.cite_text,
  );
  if (!citeInContext.ok) return { reason: "cite_text_not_in_context" };

  const contextResult = findPlainPassageMatches(
    memoText,
    citation.memo_context,
  );
  if (!contextResult.ok) return { reason: "memo_context_not_found" };
  if (contextResult.matches.length !== 1) {
    return { reason: "ambiguous_in_memo" };
  }

  const context = contextResult.matches[0];
  const rawContext = memoText.slice(context.start, context.end);
  const withinContext = findPlainPassageMatches(
    rawContext,
    citation.cite_text,
  );
  if (!withinContext.ok || withinContext.matches.length !== 1) {
    return { reason: "cite_text_not_in_context" };
  }
  const match = withinContext.matches[0];
  const start = context.start + match.start;
  const end = context.start + match.end;
  return {
    anchor: {
      start,
      end,
      quote: memoText.slice(start, end),
      match: match.match,
      warnings: memoWarnings(match).filter(
        (warning) => warning !== "multiple_matches",
      ),
    },
  };
}

function isEllipsisProposal(value: string): boolean {
  return value.includes("…") || value.includes("...");
}

export function verifyResolvedProposal(input: ResolvedVerificationInput): {
  record: VerifiedRecord;
  report: VerificationReport;
} {
  const memoText = decodeUtf8(input.memo);
  const sourceTexts = new Map<string, string>();
  for (const [key, source] of Object.entries(input.sources)) {
    sourceTexts.set(key, decodeUtf8(source));
  }

  const sources = Object.fromEntries(
    Object.entries(input.proposal.sources).map(([key, sourceProposal]) => {
      const resolved = input.sources[key];
      if (!resolved) throw new Error(`Resolved source is missing: ${key}`);
      return [
        key,
        {
          ...resolvedMetadata(resolved),
          title: sourceProposal.title,
          kind: sourceProposal.kind,
        },
      ];
    }),
  );

  const citations: VerifiedRecord["citations"] =
    input.proposal.citations.map((citation) => {
      const memoResult = memoAnchor(memoText, citation);
      const resolvedMemoAnchor =
        "anchor" in memoResult ? memoResult.anchor : null;
      const anchors: VerifiedRecord["citations"][number]["anchors"] = [];
      const anchorDiagnostics: VerifiedRecord["citations"][number]["anchor_diagnostics"] =
        [];

      citation.anchors_proposed.forEach((proposed, proposalIndex) => {
        const sourceText = sourceTexts.get(proposed.source);
        if (sourceText === undefined) {
          anchorDiagnostics.push({
            source: proposed.source,
            proposed_quote: proposed.quote,
            status: "failed",
            anchor_count: 0,
            warnings: [],
            failure_reason: "source_missing",
            hint: failureHint("source_missing", "source"),
          });
          return;
        }

        const result = findPassageMatches(sourceText, proposed.quote);
        if (!result.ok) {
          anchorDiagnostics.push({
            source: proposed.source,
            proposed_quote: proposed.quote,
            status: "failed",
            anchor_count: 0,
            warnings: [],
            failure_reason: result.reason,
            hint: failureHint(result.reason, "source"),
          });
          return;
        }

        const selected = isEllipsisProposal(proposed.quote)
          ? result.matches
          : result.matches.slice(0, 1);
        selected.forEach((match, segmentIndex) => {
          const anchor = {
            source: proposed.source,
            quote: match.quote,
            start: match.start,
            end: match.end,
            match: match.match,
            proposal_index: proposalIndex,
            segment_index: segmentIndex,
            warnings: match.warnings,
          };
          assertAnchorInvariant(sourceText, anchor);
          anchors.push(anchor);
        });
        const warnings = unique(selected.flatMap((match) => match.warnings));
        anchorDiagnostics.push({
          source: proposed.source,
          proposed_quote: proposed.quote,
          status: "anchored",
          match: selected.some((match) => match.match === "hyphenless")
            ? "hyphenless"
            : selected.some((match) => match.match === "normalized")
              ? "normalized"
              : "exact",
          anchor_count: selected.length,
          warnings,
        });
      });

      const firstSourceFailure = anchorDiagnostics.find(
        (diagnostic) => diagnostic.status === "failed",
      )?.failure_reason;
      const memoFailure =
        "reason" in memoResult ? memoResult.reason : undefined;
      const failureReason = memoFailure ?? firstSourceFailure;
      const status =
        failureReason !== undefined
          ? ("anchor_failed" as const)
          : citation.anchors_proposed.length === 0
            ? ("no_quote_claimed" as const)
            : ("anchored" as const);
      const warnings = unique([
        ...(resolvedMemoAnchor?.warnings ?? []),
        ...anchorDiagnostics.flatMap((diagnostic) => diagnostic.warnings),
      ]);
      const bindsTo = bindingHash({
        sourceCandidates: citation.source_candidates.map((sourceKey) => {
          const source = input.sources[sourceKey];
          if (!source) {
            throw new Error(`Resolved source is missing: ${sourceKey}`);
          }
          return {
            source: sourceKey,
            documentId: source.documentId,
            versionId: source.versionId,
          };
        }),
        citeText: citation.cite_text,
        proposition: citation.proposition,
        supportType: citation.support_type,
        pin: citation.pin,
        anchors: anchors.map(({ source, quote }) => ({ source, quote })),
      });

      return {
        id: citation.id,
        source_candidates: citation.source_candidates,
        cite_text: citation.cite_text,
        ...(citation.memo_context
          ? { memo_context: citation.memo_context }
          : {}),
        ...(citation.pin ? { pin: citation.pin } : {}),
        memo_anchor: resolvedMemoAnchor,
        proposition: citation.proposition,
        support_type: citation.support_type,
        anchors,
        anchor_diagnostics: anchorDiagnostics,
        warnings,
        status,
        binds_to: bindsTo,
        ...(failureReason ? { failure_reason: failureReason } : {}),
      };
    });

  const failedCitations = citations.filter(
    (citation) => citation.status === "anchor_failed",
  );
  const anchoredCitations = citations.filter(
    (citation) => citation.status === "anchored",
  );
  const formattingDifferent = anchoredCitations.filter(
    (citation) =>
      citation.memo_anchor?.match !== "exact" ||
      citation.anchors.some((anchor) => anchor.match !== "exact"),
  );
  const record = verifiedRecordSchema.parse({
    schema_version: 1,
    memo: resolvedMetadata(input.memo),
    sources,
    citations,
  });
  const reportFailures: VerificationReport["failures"] = [];
  for (const citation of citations) {
    if (citation.status !== "anchor_failed") continue;
    if (!citation.memo_anchor) {
      const reason = citation.failure_reason ?? "not_found";
      reportFailures.push({
        citation_id: citation.id,
        scope: "memo",
        reason,
        hint: failureHint(reason, "memo"),
      });
      continue;
    }
    for (const diagnostic of citation.anchor_diagnostics) {
      if (diagnostic.status !== "failed") continue;
      reportFailures.push({
        citation_id: citation.id,
        scope: "source",
        source: diagnostic.source,
        reason: diagnostic.failure_reason ?? "not_found",
        hint:
          diagnostic.hint ??
          failureHint(
            diagnostic.failure_reason ?? "not_found",
            "source",
          ),
      });
    }
  }
  const reportWarnings = citations.flatMap((citation) => {
    const memoWarnings = (citation.memo_anchor?.warnings ?? []).map(
      (warning) => ({
        citation_id: citation.id,
        warning,
        hint: warningHint(warning),
      }),
    );
    const sourceWarnings = citation.anchor_diagnostics.flatMap((diagnostic) =>
      diagnostic.warnings.map((warning) => ({
        citation_id: citation.id,
        source: diagnostic.source,
        warning,
        hint: warningHint(warning),
      })),
    );
    return [...memoWarnings, ...sourceWarnings];
  });
  const report = verificationReportSchema.parse({
    outcome:
      failedCitations.length === 0 ? "success" : "completed_with_failures",
    total: citations.length,
    anchored: anchoredCitations.length,
    failed: failedCitations.length,
    no_quote_claimed: citations.filter(
      (citation) => citation.status === "no_quote_claimed",
    ).length,
    exact: anchoredCitations.length - formattingDifferent.length,
    formatting_different: formattingDifferent.length,
    warnings: reportWarnings,
    failures: reportFailures,
  });

  return { record, report };
}

export { normalizeWithPositions };
