import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const documentIdSchema = z.string().trim().min(1).max(200);
const versionIdSchema = z.string().trim().min(1).max(200);
const citationIdSchema = z.string().regex(/^c\d{3,}$/);
export const verificationFailureReasonSchema = z.enum([
  // Retained for records written by the initial vertical slice.
  "memo_citation_not_found",
  "source_passage_not_found",
  "not_found",
  "case_mismatch",
  "ambiguous_in_memo",
  "memo_context_not_found",
  "cite_text_not_in_context",
  "segment_too_short",
  "ellipsis_gap_too_large",
  "ellipsis_out_of_order",
  "source_missing",
]);
export const matchTierSchema = z.enum(["exact", "normalized", "hyphenless"]);
export const verificationWarningSchema = z.enum([
  "multiple_matches",
  "short_passage",
  "source_header_match",
]);

export const documentReferenceSchema = z.object({
  document_id: documentIdSchema,
  version_id: versionIdSchema.optional(),
  label: z.string().trim().min(1).max(500).optional(),
});

export const sourceKindSchema = z.enum([
  "case",
  "statute",
  "brief",
  "evidence",
  "secondary",
  "other",
]);

export const verificationSourceSchema = documentReferenceSchema.extend({
  title: z.string().trim().min(1).max(500),
  kind: sourceKindSchema,
});

export const verificationCitationSchema = z
  .object({
    id: citationIdSchema,
    source_candidates: z
      .array(z.string().trim().min(1).max(200))
      .min(1)
      .max(20)
      .refine((sources) => new Set(sources).size === sources.length, {
        message: "Source candidates must be unique",
      }),
    cite_text: z.string().min(1).max(10_000),
    memo_context: z.string().min(1).max(50_000).optional(),
    pin: z.string().trim().min(1).max(1_000).optional(),
    proposition: z.string().trim().min(1).max(20_000),
    support_type: z.enum(["quotation", "paraphrase"]),
    anchors_proposed: z
      .array(
        z
          .object({
            source: z.string().trim().min(1).max(200),
            quote: z.string().min(1).max(50_000),
          })
          .strict(),
      )
      .min(0)
      .max(3),
  })
  .strict();

export const verificationProposalSchema = z
  .object({
    schema_version: z.literal(1),
    memo: documentReferenceSchema,
    sources: z.record(
      z.string().trim().min(1).max(200),
      verificationSourceSchema,
    ),
    citations: z.array(verificationCitationSchema).min(1).max(250),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    value.citations.forEach((citation, index) => {
      if (ids.has(citation.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["citations", index, "id"],
          message: `Duplicate citation id: ${citation.id}`,
        });
      }
      ids.add(citation.id);
      citation.source_candidates.forEach((source, sourceIndex) => {
        if (!Object.hasOwn(value.sources, source)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["citations", index, "source_candidates", sourceIndex],
            message: `Unknown source: ${source}`,
          });
        }
      });
      citation.anchors_proposed.forEach((anchor, anchorIndex) => {
        if (!Object.hasOwn(value.sources, anchor.source)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["citations", index, "anchors_proposed", anchorIndex, "source"],
            message: `Unknown source: ${anchor.source}`,
          });
        } else if (!citation.source_candidates.includes(anchor.source)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["citations", index, "anchors_proposed", anchorIndex, "source"],
            message: `Proposed anchor source is not a candidate: ${anchor.source}`,
          });
        }
      });
    });
  });

const textSpanSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict();

export const textAnchorSchema = textSpanSchema
  .extend({
    source: z.string().trim().min(1).max(200),
    quote: z.string().min(1),
    match: matchTierSchema.default("exact"),
    proposal_index: z.number().int().nonnegative().default(0),
    segment_index: z.number().int().nonnegative().default(0),
    warnings: z.array(verificationWarningSchema).default([]),
  })
  .strict()
  .superRefine((anchor, ctx) => {
    if (anchor.end <= anchor.start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Anchor end must be after start",
      });
    }
    if (anchor.end - anchor.start !== anchor.quote.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Anchor span length must equal quote length",
      });
    }
  });

const memoAnchorSchema = textSpanSchema
  .extend({
    quote: z.string().default(""),
    match: matchTierSchema.default("exact"),
    warnings: z.array(verificationWarningSchema).default([]),
  })
  .strict();

const anchorDiagnosticSchema = z
  .object({
    source: z.string().trim().min(1).max(200),
    proposed_quote: z.string().min(1),
    status: z.enum(["anchored", "failed"]),
    match: matchTierSchema.optional(),
    anchor_count: z.number().int().nonnegative(),
    warnings: z.array(verificationWarningSchema),
    failure_reason: verificationFailureReasonSchema.optional(),
    hint: z.string().min(1).optional(),
  })
  .strict();

const resolvedDocumentSchema = z.object({
  document_id: documentIdSchema,
  version_id: versionIdSchema,
  filename: z.string().min(1),
  sha256: sha256Schema,
  bytes: z.number().int().nonnegative(),
  provider: z.string().trim().min(1).max(100).optional(),
  origin_url: z.string().url().optional(),
});

const verifiedSourceSchema = resolvedDocumentSchema.extend({
  title: z.string().min(1),
  kind: sourceKindSchema,
});

const verifiedCitationSchema = z
  .object({
    id: citationIdSchema,
    source_candidates: z.array(z.string().min(1)).min(1),
    cite_text: z.string().min(1),
    memo_context: z.string().min(1).optional(),
    pin: z.string().min(1).optional(),
    memo_anchor: memoAnchorSchema.nullable(),
    proposition: z.string().min(1),
    support_type: z.enum(["quotation", "paraphrase"]),
    anchors: z.array(textAnchorSchema),
    anchor_diagnostics: z.array(anchorDiagnosticSchema).default([]),
    warnings: z.array(verificationWarningSchema).default([]),
    status: z.enum(["anchored", "no_quote_claimed", "anchor_failed"]),
    binds_to: sha256Schema,
    failure_reason: verificationFailureReasonSchema.optional(),
  })
  .strict()
  .superRefine((citation, ctx) => {
    if (citation.status === "anchored" && citation.anchors.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Anchored citations require at least one anchor",
      });
    }
    if (
      citation.status === "no_quote_claimed" &&
      citation.anchors.length !== 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "No-quote citations cannot contain anchors",
      });
    }
  });

export const verifiedRecordSchema = z
  .object({
    schema_version: z.literal(1),
    memo: resolvedDocumentSchema,
    sources: z.record(z.string(), verifiedSourceSchema),
    citations: z.array(verifiedCitationSchema),
  })
  .strict();

export const verificationReportSchema = z
  .object({
    outcome: z.enum(["success", "completed_with_failures"]),
    total: z.number().int().nonnegative(),
    anchored: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    no_quote_claimed: z.number().int().nonnegative().default(0),
    exact: z.number().int().nonnegative().default(0),
    formatting_different: z.number().int().nonnegative().default(0),
    warnings: z.array(
      z
        .object({
          citation_id: citationIdSchema,
          warning: verificationWarningSchema,
          source: z.string().min(1).optional(),
          hint: z.string().min(1),
        })
        .strict(),
    ).default([]),
    failures: z.array(
      z
        .object({
          citation_id: citationIdSchema,
          scope: z.enum(["memo", "source"]).default("source"),
          source: z.string().min(1).optional(),
          reason: verificationFailureReasonSchema,
          hint: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export type VerificationProposal = z.infer<typeof verificationProposalSchema>;
export type VerificationSource = z.infer<typeof verificationSourceSchema>;
export type VerifiedRecord = z.infer<typeof verifiedRecordSchema>;
export type VerificationReport = z.infer<typeof verificationReportSchema>;
export type TextAnchor = z.infer<typeof textAnchorSchema>;
export type VerificationFailureReason = z.infer<
  typeof verificationFailureReasonSchema
>;
export type VerificationWarning = z.infer<typeof verificationWarningSchema>;

export function assertAnchorInvariant(raw: string, anchor: TextAnchor): void {
  if (raw.slice(anchor.start, anchor.end) !== anchor.quote) {
    throw new Error(
      `Anchor invariant failed: raw.slice(${anchor.start}, ${anchor.end}) does not equal quote`,
    );
  }
}
