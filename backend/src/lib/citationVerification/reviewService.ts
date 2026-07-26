import { createHash } from "node:crypto";
import { z } from "zod";
import { downloadFile } from "../storage";
import { createServerSupabase } from "../supabase";
import {
  verificationReportSchema,
  verifiedRecordSchema,
  type VerificationReport,
  type VerifiedRecord,
} from "./schemas";
import { segmentText, type TextSegment } from "./segmentation";

type Db = ReturnType<typeof createServerSupabase>;

export const reviewVerdictSchema = z.enum([
  "verified",
  "needs_attention",
  "rejected",
]);

export const createReviewSchema = z
  .object({
    citation_id: z.string().regex(/^c\d{3,}$/),
    binds_to: z.string().regex(/^[a-f0-9]{64}$/),
    verdict: reviewVerdictSchema,
    note: z.string().max(5_000).nullable().optional(),
  })
  .strict();

export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

export type CitationVerificationReview = {
  id: string;
  run_id: string;
  citation_id: string;
  binds_to: string;
  verdict: ReviewVerdict;
  note: string | null;
  reviewer_user_id: string;
  reviewer_email: string | null;
  created_at: string;
  stale: boolean;
};

type StoredReviewRow = Omit<CitationVerificationReview, "stale">;

type VersionRow = {
  id: string;
  document_id: string;
  storage_path: string | null;
  filename: string | null;
};

type ExternalSourceRow = {
  id: string;
  project_id: string | null;
  version_id: string;
  title: string;
  content_text: string | null;
  content_hash: string;
  content_bytes: number;
  document_id: string | null;
  document_version_id: string | null;
};

export type IntegrityStatus = "ok" | "changed" | "missing";

export type AuthorityTraceWorkspace = {
  id: string;
  project_id: string;
  created_at: string;
  verified_record: VerifiedRecord;
  report: VerificationReport;
  memo: {
    document_id: string;
    version_id: string;
    filename: string;
    available: boolean;
    integrity: IntegrityStatus;
    segments: TextSegment[];
  };
  sources: Record<
    string,
    {
      document_id: string;
      version_id: string;
      filename: string;
      title: string;
      kind: string;
      available: boolean;
      integrity: IntegrityStatus;
      segments: TextSegment[];
    }
  >;
  reviews: CitationVerificationReview[];
  current_reviews: Record<string, CitationVerificationReview>;
  integrity: {
    ok: boolean;
    warnings: Array<{
      scope: "memo" | "source";
      source?: string;
      status: Exclude<IntegrityStatus, "ok">;
      message: string;
    }>;
  };
};

export class ReviewBindingChangedError extends Error {
  constructor() {
    super("Citation content changed; reload the run before saving a verdict");
    this.name = "ReviewBindingChangedError";
  }
}

function decodeUtf8(content: ArrayBuffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function byteIdentity(content: Uint8Array) {
  return {
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: content.byteLength,
  };
}

function contentIdentity(text: string) {
  return byteIdentity(Buffer.from(text, "utf8"));
}

function integrityStatus(
  text: string | undefined,
  expected: { sha256: string; bytes: number },
  actualIdentity?: { sha256: string; bytes: number },
): IntegrityStatus {
  if (text === undefined) return "missing";
  const actual = actualIdentity ?? contentIdentity(text);
  return actual.sha256 === expected.sha256 && actual.bytes === expected.bytes
    ? "ok"
    : "changed";
}

function latestReview(
  rows: CitationVerificationReview[],
): CitationVerificationReview | undefined {
  return [...rows].sort((a, b) => {
    const time = b.created_at.localeCompare(a.created_at);
    return time !== 0 ? time : b.id.localeCompare(a.id);
  })[0];
}

export async function getAuthorityTraceWorkspace(
  runId: string,
  db: Db = createServerSupabase(),
): Promise<AuthorityTraceWorkspace | null> {
  const { data: runData, error: runError } = await db
    .from("citation_verification_runs")
    .select("id, project_id, verified_record, report, created_at")
    .eq("id", runId)
    .maybeSingle();
  if (runError) throw new Error(runError.message);
  if (!runData) return null;

  const record = verifiedRecordSchema.parse(runData.verified_record);
  const report = verificationReportSchema.parse(runData.report);
  const allReferences = [record.memo, ...Object.values(record.sources)];
  const { data: documentData, error: documentError } = await db
    .from("documents")
    .select("id")
    .in(
      "id",
      Array.from(
        new Set(allReferences.map((reference) => reference.document_id)),
      ),
    )
    .eq("project_id", String(runData.project_id));
  if (documentError) throw new Error(documentError.message);
  const accessibleDocumentIds = new Set(
    ((documentData ?? []) as Array<{ id: string }>).map((row) => row.id),
  );
  const projectReferences = allReferences.filter((reference) =>
    accessibleDocumentIds.has(reference.document_id),
  );
  const versionIds = Array.from(
    new Set(projectReferences.map((reference) => reference.version_id)),
  );
  const { data: versionData, error: versionError } = await db
    .from("document_versions")
    .select("id, document_id, storage_path, filename")
    .in("id", versionIds)
    .is("deleted_at", null);
  if (versionError) throw new Error(versionError.message);
  const versions = (versionData ?? []) as VersionRow[];
  const versionById = new Map(versions.map((version) => [version.id, version]));
  const externalDocumentIds = Array.from(
    new Set(
      Object.values(record.sources)
        .filter(
          (source) =>
            !accessibleDocumentIds.has(source.document_id) ||
            !versionById.has(source.version_id),
        )
        .map((source) => source.document_id),
    ),
  );
  const { data: externalData, error: externalError } =
    externalDocumentIds.length
      ? await db
          .from("external_source_cache")
          .select(
            "id, project_id, version_id, title, content_text, content_hash, content_bytes, document_id, document_version_id",
          )
          .in("id", externalDocumentIds)
          .eq("project_id", String(runData.project_id))
      : { data: [], error: null };
  if (externalError) throw new Error(externalError.message);
  const externalById = new Map(
    ((externalData ?? []) as ExternalSourceRow[]).map((source) => [
      source.id,
      source,
    ]),
  );
  const externalVersionIds = Array.from(
    new Set(
      [...externalById.values()].flatMap((source) =>
        source.document_version_id ? [source.document_version_id] : [],
      ),
    ),
  );
  const { data: externalVersionData, error: externalVersionError } =
    externalVersionIds.length
      ? await db
          .from("document_versions")
          .select("id, document_id, storage_path, filename")
          .in("id", externalVersionIds)
          .is("deleted_at", null)
      : { data: [], error: null };
  if (externalVersionError) throw new Error(externalVersionError.message);
  const externalVersionById = new Map(
    ((externalVersionData ?? []) as VersionRow[]).map((version) => [
      version.id,
      version,
    ]),
  );
  const textByVersion = new Map<string, string>();
  const identityByVersion = new Map<
    string,
    { sha256: string; bytes: number }
  >();
  for (const reference of projectReferences) {
    const version = versionById.get(reference.version_id);
    if (
      !version ||
      version.document_id !== reference.document_id ||
      !version.storage_path ||
      textByVersion.has(version.id)
    ) {
      continue;
    }
    const content = await downloadFile(version.storage_path);
    if (!content) continue;
    identityByVersion.set(version.id, byteIdentity(new Uint8Array(content)));
    textByVersion.set(
      version.id,
      decodeUtf8(content, `${reference.document_id}/${reference.version_id}`),
    );
  }
  const externalTextById = new Map<string, string>();
  const externalIdentityById = new Map<
    string,
    { sha256: string; bytes: number }
  >();
  for (const source of externalById.values()) {
    if (source.document_id && source.document_version_id) {
      const version = externalVersionById.get(source.document_version_id);
      if (
        !version ||
        version.document_id !== source.document_id ||
        !version.storage_path
      ) {
        continue;
      }
      const content = await downloadFile(version.storage_path);
      if (!content) continue;
      externalIdentityById.set(
        source.id,
        byteIdentity(new Uint8Array(content)),
      );
      externalTextById.set(
        source.id,
        decodeUtf8(
          content,
          `${source.document_id}/${source.document_version_id}`,
        ),
      );
      continue;
    }
    // Compatibility for pre-0024 rows; normal cache reads migrate these into
    // DMS documents and clear content_text.
    if (source.content_text !== null) {
      externalTextById.set(source.id, source.content_text);
      externalIdentityById.set(source.id, contentIdentity(source.content_text));
    }
  }

  const { data: projectRunData, error: projectRunError } = await db
    .from("citation_verification_runs")
    .select("id")
    .eq("project_id", String(runData.project_id));
  if (projectRunError) throw new Error(projectRunError.message);
  const projectRunIds = ((projectRunData ?? []) as Array<{ id: string }>).map(
    (row) => row.id,
  );
  const { data: reviewData, error: reviewError } = await db
    .from("citation_verification_reviews")
    .select(
      "id, run_id, citation_id, binds_to, verdict, note, reviewer_user_id, reviewer_email, created_at",
    )
    .in("run_id", projectRunIds)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (reviewError) throw new Error(reviewError.message);
  const currentBindings = new Set(
    record.citations.map((citation) => citation.binds_to),
  );
  const reviews = ((reviewData ?? []) as StoredReviewRow[]).map((review) => ({
    ...review,
    stale: !currentBindings.has(review.binds_to),
  }));
  const currentReviews = Object.fromEntries(
    record.citations.flatMap((citation) => {
      const current = latestReview(
        reviews.filter((review) => review.binds_to === citation.binds_to),
      );
      return current ? [[citation.id, current]] : [];
    }),
  );

  const memoText = textByVersion.get(record.memo.version_id);
  const memoIntegrity = integrityStatus(
    memoText,
    record.memo,
    identityByVersion.get(record.memo.version_id),
  );
  const memoHighlights = record.citations.flatMap((citation) =>
    citation.memo_anchor
      ? [
          {
            citation_id: citation.id,
            start: citation.memo_anchor.start,
            end: citation.memo_anchor.end,
          },
        ]
      : [],
  );
  const sources = Object.fromEntries(
    Object.entries(record.sources).map(([sourceKey, source]) => {
      const external = externalById.get(source.document_id);
      const text =
        external?.version_id === source.version_id
          ? externalTextById.get(external.id)
          : textByVersion.get(source.version_id);
      const sourceIntegrity = integrityStatus(
        text,
        source,
        external
          ? externalIdentityById.get(external.id)
          : identityByVersion.get(source.version_id),
      );
      const highlights = record.citations.flatMap((citation) =>
        citation.anchors
          .filter((anchor) => anchor.source === sourceKey)
          .map((anchor) => ({
            citation_id: citation.id,
            start: anchor.start,
            end: anchor.end,
          })),
      );
      return [
        sourceKey,
        {
          document_id: source.document_id,
          version_id: source.version_id,
          filename: source.filename,
          title: source.title,
          kind: source.kind,
          available: text !== undefined,
          integrity: sourceIntegrity,
          segments: segmentText(
            text ?? "",
            sourceIntegrity === "ok" ? highlights : [],
          ),
        },
      ];
    }),
  );
  const integrityWarnings: AuthorityTraceWorkspace["integrity"]["warnings"] =
    [];
  if (memoIntegrity !== "ok") {
    integrityWarnings.push({
      scope: "memo",
      status: memoIntegrity,
      message:
        memoIntegrity === "missing"
          ? "The verified memo version is unavailable."
          : "The memo bytes no longer match this run; highlights are suppressed.",
    });
  }
  for (const [sourceKey, source] of Object.entries(sources)) {
    if (source.integrity === "ok") continue;
    integrityWarnings.push({
      scope: "source",
      source: sourceKey,
      status: source.integrity,
      message:
        source.integrity === "missing"
          ? `${source.title} is unavailable.`
          : `${source.title} no longer matches this run; highlights are suppressed.`,
    });
  }

  return {
    id: String(runData.id),
    project_id: String(runData.project_id),
    created_at: String(runData.created_at),
    verified_record: record,
    report,
    memo: {
      document_id: record.memo.document_id,
      version_id: record.memo.version_id,
      filename: record.memo.filename,
      available: memoText !== undefined,
      integrity: memoIntegrity,
      segments: segmentText(
        memoText ?? "",
        memoIntegrity === "ok" ? memoHighlights : [],
      ),
    },
    sources,
    reviews,
    current_reviews: currentReviews,
    integrity: {
      ok: integrityWarnings.length === 0,
      warnings: integrityWarnings,
    },
  };
}

export async function createCitationVerificationReview(
  input: {
    runId: string;
    body: unknown;
    reviewerUserId: string;
    reviewerEmail?: string | null;
  },
  db: Db = createServerSupabase(),
): Promise<CitationVerificationReview> {
  const parsed = createReviewSchema.parse(input.body);
  const { data: runData, error: runError } = await db
    .from("citation_verification_runs")
    .select("verified_record")
    .eq("id", input.runId)
    .maybeSingle();
  if (runError) throw new Error(runError.message);
  if (!runData) throw new Error("Verification run not found");
  const record = verifiedRecordSchema.parse(runData.verified_record);
  const citation = record.citations.find(
    (candidate) => candidate.id === parsed.citation_id,
  );
  if (!citation) throw new Error("Citation is not part of this run");
  if (citation.binds_to !== parsed.binds_to) {
    throw new ReviewBindingChangedError();
  }

  const { data, error } = await db
    .from("citation_verification_reviews")
    .insert({
      run_id: input.runId,
      citation_id: parsed.citation_id,
      binds_to: parsed.binds_to,
      verdict: parsed.verdict,
      note: parsed.note?.trim() || null,
      reviewer_user_id: input.reviewerUserId,
      reviewer_email: input.reviewerEmail?.trim() || null,
    })
    .select(
      "id, run_id, citation_id, binds_to, verdict, note, reviewer_user_id, reviewer_email, created_at",
    )
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "Failed to save citation review");
  }
  return {
    ...(data as StoredReviewRow),
    stale: false,
  };
}
