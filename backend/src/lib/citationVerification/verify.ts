import { createHash } from "node:crypto";
import {
  assertAnchorInvariant,
  verificationReportSchema,
  verifiedRecordSchema,
  type VerificationProposal,
  type VerificationReport,
  type VerifiedRecord,
} from "./schemas";

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
  anchors: Array<{ source: string; quote: string }>;
}): string {
  return sha256(
    JSON.stringify([
      input.sourceCandidates,
      input.citeText,
      input.proposition,
      input.supportType,
      input.anchors,
    ]),
  );
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
      const memoStart = memoText.indexOf(citation.cite_text);
      const memoAnchor =
        memoStart >= 0
          ? {
              start: memoStart,
              end: memoStart + citation.cite_text.length,
            }
          : null;

      const anchors = citation.anchors_proposed.flatMap((proposed) => {
        const sourceText = sourceTexts.get(proposed.source);
        if (sourceText === undefined) {
          throw new Error(`Resolved source is missing: ${proposed.source}`);
        }
        const start = sourceText.indexOf(proposed.quote);
        if (start < 0) return [];
        const anchor = {
          source: proposed.source,
          quote: proposed.quote,
          start,
          end: start + proposed.quote.length,
          match: "exact" as const,
        };
        assertAnchorInvariant(sourceText, anchor);
        return [anchor];
      });
      const anchored =
        memoAnchor !== null &&
        anchors.length === citation.anchors_proposed.length;
      const failureReason =
        memoAnchor === null
          ? "memo_citation_not_found"
          : "source_passage_not_found";
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
        anchors: anchors.map(({ source, quote }) => ({ source, quote })),
      });

      return anchored
        ? {
            id: citation.id,
            source_candidates: citation.source_candidates,
            cite_text: citation.cite_text,
            memo_anchor: memoAnchor,
            proposition: citation.proposition,
            support_type: citation.support_type,
            anchors,
            status: "anchored" as const,
            binds_to: bindsTo,
          }
        : {
            id: citation.id,
            source_candidates: citation.source_candidates,
            cite_text: citation.cite_text,
            memo_anchor: memoAnchor,
            proposition: citation.proposition,
            support_type: citation.support_type,
            anchors,
            status: "anchor_failed" as const,
            binds_to: bindsTo,
            failure_reason: failureReason,
          };
    });

  const failedCitations = citations.filter(
    (citation) => citation.status === "anchor_failed",
  );
  const record = verifiedRecordSchema.parse({
    schema_version: 1,
    memo: resolvedMetadata(input.memo),
    sources,
    citations,
  });
  const report = verificationReportSchema.parse({
    outcome:
      failedCitations.length === 0 ? "success" : "completed_with_failures",
    total: citations.length,
    anchored: citations.length - failedCitations.length,
    failed: failedCitations.length,
    failures: failedCitations.map((citation) => ({
      citation_id: citation.id,
      reason: citation.failure_reason ?? "not_found",
      hint:
        citation.failure_reason === "memo_citation_not_found"
          ? "The citation text was not found exactly in the memo version."
          : "One or more proposed passages were not found exactly in the source version.",
    })),
  });

  return { record, report };
}
