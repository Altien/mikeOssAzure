import { randomUUID } from "node:crypto";
import { checkProjectAccess } from "../../../lib/access";
import { buildDownloadUrl } from "../../../lib/downloadTokens";
import { uploadFile, versionStorageKey } from "../../../lib/storage";
import { createServerSupabase } from "../../../lib/supabase";
import { createDocumentVersion } from "../../../modules/documents/documents.service";
import { buildReviewHtml } from "./htmlExports";
import { getAuthorityTraceWorkspace } from "./reviewService";
import { getCitationVerificationRun } from "./service";

type Db = ReturnType<typeof createServerSupabase>;

export type CitationReviewExportResult =
  | {
      ok: true;
      run_id: string;
      export_type: "review";
      filename: string;
      download_url: string;
      document_id: string;
      version_id: string;
      run_created_at: string;
      integrity: "ok";
      citations: {
        total: number;
        anchored: number;
        failed: number;
        exact: number;
        formatting_different: number;
        no_quote_claimed: number;
      };
      reviews: {
        current_verdicts: number;
        stale_verdicts: number;
      };
    }
  | {
      ok: false;
      error: "not_found";
      detail: string;
    }
  | {
      ok: false;
      error: "integrity_check_failed";
      detail: string;
      warnings: string[];
      instruction: string;
    };

function notFound(): CitationReviewExportResult {
  return {
    ok: false,
    error: "not_found",
    detail: "Verification run not found",
  };
}

/**
 * Chat tools do not carry `res.locals.userEmail`, and checkProjectAccess
 * matches shared project members by email. Without it a colleague the project
 * was shared with would be told their own run does not exist. Every
 * authenticated request refreshes this row from the IdP, so it is the same
 * address the HTTP export route checks against.
 */
async function callerEmail(userId: string, db: Db): Promise<string | null> {
  const { data } = await db
    .from("user_profiles")
    .select("email")
    .eq("user_id", userId)
    .maybeSingle();
  const email = (data as { email?: string | null } | null)?.email;
  return typeof email === "string" ? email : null;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/**
 * Render the offline review report for a persisted verification run.
 *
 * Read-only with respect to the run: it re-reads the workspace, revalidates
 * memo and source integrity, and returns a download reference. It never
 * records a reviewer verdict — that stays a human act with an attributed
 * reviewer identity — and never mutates the run or its verified record.
 */
export async function exportCitationReview(
  input: {
    runId: string;
    userId: string;
    projectId: string;
  },
  db: Db = createServerSupabase(),
): Promise<CitationReviewExportResult> {
  const run = await getCitationVerificationRun(input.runId, db);
  // A run outside this chat's project, or in a project the caller cannot
  // reach, is reported exactly as one that does not exist — the export must
  // not become an oracle for run ids the caller was never shown.
  if (!run || run.project_id !== input.projectId) return notFound();
  const access = await checkProjectAccess(
    run.project_id,
    input.userId,
    await callerEmail(input.userId, db),
    db,
  );
  if (!access.ok) return notFound();
  const workspace = await getAuthorityTraceWorkspace(run.id, db);
  if (!workspace) return notFound();

  // The HTTP route lets a person export a degraded report after being told it
  // is untrustworthy (force_degraded). That is the whole point of the gate: a
  // human deciding to rely on a report whose inputs no longer match. The tool
  // has no equivalent parameter and refuses instead.
  if (!workspace.integrity.ok) {
    return {
      ok: false,
      error: "integrity_check_failed",
      detail: "Export blocked because memo or source integrity checks failed",
      warnings: workspace.integrity.warnings.map((warning) => warning.message),
      instruction:
        "Do not export this run. Tell the user which memo or source inputs changed or went missing, and that only a person can choose to produce a degraded report from the Authority Trace review view.",
    };
  }

  const bytes = new TextEncoder().encode(buildReviewHtml(workspace));
  const documentId = randomUUID();
  const versionId = randomUUID();
  const filename = `authority-trace-${run.id}-review.html`;
  const storagePath = versionStorageKey(
    input.userId,
    documentId,
    versionId,
    filename,
  );

  // Upload before any metadata write, as extraction does: unconfigured storage
  // fails visibly rather than leaving a row pointing at a blob never written.
  await uploadFile(
    storagePath,
    exactArrayBuffer(bytes),
    "text/html; charset=utf-8",
  );

  // The rendered report is recorded as a generated project document because
  // that is what makes a signed download link resolvable: /download/:token
  // looks the storage path up through document_versions and re-checks document
  // access at click time. Nothing about the run itself is written.
  const { error: documentError } = await db.from("documents").insert({
    id: documentId,
    project_id: input.projectId,
    user_id: input.userId,
    status: "ready",
  });
  if (documentError) throw new Error(documentError.message);
  const { error: versionError } = await createDocumentVersion(db, {
    id: versionId,
    document_id: documentId,
    storage_path: storagePath,
    pdf_storage_path: null,
    source: "generated",
    version_number: 1,
    filename,
    file_type: "html",
    size_bytes: bytes.byteLength,
    page_count: null,
  });
  if (versionError) throw new Error(versionError.message);
  const { error: currentVersionError } = await db
    .from("documents")
    .update({ current_version_id: versionId })
    .eq("id", documentId);
  if (currentVersionError) throw new Error(currentVersionError.message);

  return {
    ok: true,
    run_id: run.id,
    export_type: "review",
    filename,
    download_url: buildDownloadUrl(storagePath, filename),
    document_id: documentId,
    version_id: versionId,
    run_created_at: workspace.created_at,
    integrity: "ok",
    citations: {
      total: workspace.report.total,
      anchored: workspace.report.anchored,
      failed: workspace.report.failed,
      exact: workspace.report.exact,
      formatting_different: workspace.report.formatting_different,
      no_quote_claimed: workspace.report.no_quote_claimed,
    },
    reviews: {
      current_verdicts: Object.keys(workspace.current_reviews).length,
      stale_verdicts: workspace.reviews.filter((review) => review.stale).length,
    },
  };
}
