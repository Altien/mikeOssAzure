import { createHash } from "node:crypto";
import { downloadFile } from "../../lib/storage";
import { extractDocxBodyText } from "../../lib/docxTrackedChanges";
import { extractPdfTextForIndex } from "../../lib/pdfText";
import { docxToPdf } from "../../lib/convert";
import { extractPresentationText } from "../../lib/officeText";
import { spreadsheetToLLMText } from "../../lib/spreadsheet";
import { isSpreadsheetDocumentType, requiresLibreOfficeTextExtraction } from "../../lib/documentTypes";
import type { Db, DbJob } from "../../lib/dbq/types";
import { processClaimedJob, STALE_SECONDS } from "../../lib/dbq/runner";

/** Complete text, using the same accepted DOCX view as the edit matcher. */
export async function extractDocumentText(raw: ArrayBuffer, fileType: string) {
  const type = fileType.toLowerCase();
  if (type === "pdf") return extractPdfTextForIndex(raw);
  if (requiresLibreOfficeTextExtraction(type)) {
    const pdf = await docxToPdf(Buffer.from(raw));
    return extractPdfTextForIndex(Uint8Array.from(pdf).buffer);
  }
  let text: string;
  if (type === "docx") {
    text = await extractDocxBodyText(Buffer.from(raw));
    if (!text) text = (await (await import("mammoth")).extractRawText({ buffer: Buffer.from(raw) })).value;
  } else if (isSpreadsheetDocumentType(type)) {
    text = spreadsheetToLLMText(Buffer.from(raw));
  } else if (type === "pptx") {
    text = await extractPresentationText(Buffer.from(raw));
  } else {
    throw new Error("document_text_unsupported_format");
  }
  return { text, textlessPageCount: null };
}

/** Extract and publish only while the queued version revision still matches. */
export async function handleDocumentExtractText(db: Db, job: DbJob): Promise<void> {
  const { versionId, revision } = job.payload;
  if (typeof versionId !== "string" || typeof revision !== "string") return;
  const { data: version, error } = await db.from("document_versions")
    .select("id,storage_path,file_type,filename,content_sha256,text_revision")
    .eq("id", versionId).eq("text_revision", revision).is("deleted_at", null).maybeSingle();
  if (error) throw error;
  if (!version?.storage_path) return; // superseded/deleted work is a successful no-op
  if (!job.claim_token) throw new Error("Document text job has no claim fence");
  const identity = { p_job_id: job.id,p_attempt: job.attempts,p_token: job.claim_token,
    p_version_id: versionId,p_revision: revision };
  const { data: claim,error: claimError } = await db.rpc("claim_document_text_job",identity);
  if (claimError) throw claimError;
  if (claim !== true) return; // stale/cancelled/deleted/replaced claim
  const raw = await downloadFile(version.storage_path);
  if (!raw) throw new Error("document_text_source_unavailable");
  const hash = createHash("sha256").update(Buffer.from(raw)).digest("hex");
  if (version.content_sha256 && version.content_sha256 !== hash) throw new Error("document_text_source_changed");
  const { text, textlessPageCount } = await extractDocumentText(raw,
    version.file_type || version.filename?.split(".").pop() || "");
  const { error: publishError } = await db.rpc("publish_document_text", {
    ...identity,
    // PostgreSQL text cannot contain NUL; do not truncate otherwise.
    p_text: text.replaceAll("\0", ""), p_sha256: hash, p_textless_pages: textlessPageCount,
  });
  if (publishError) throw publishError;
}

/** Mark exhausted work failed without overwriting a newer revision or ready text. */
export async function markDocumentTextFailed(db: Db, job: DbJob): Promise<void> {
  const { versionId,revision } = job.payload;
  if (typeof versionId !== "string" || typeof revision !== "string" || !job.claim_token) return;
  const { error } = await db.rpc("fail_document_text_job", {
    p_job_id: job.id,p_attempt: job.attempts,p_token: job.claim_token,
    p_version_id: versionId,p_revision: revision,
  });
  if (error) throw error;
}

/** Escape-hatch deployments still process durable text work without a runner. */
export async function processDocumentTextInline(db: Db, versionIds?: string[]) {
  if (process.env.DB_JOBS_ENABLED !== "false") return;
  let query = db.from("db_jobs").select("*").eq("kind", "document.extract_text").eq("status", "pending");
  if (versionIds?.length) query = query.in("payload->>versionId", versionIds);
  const { data, error } = await query.order("created_at").limit(versionIds?.length ?? 5);
  if (error) throw error;
  for (const candidate of (data ?? []) as DbJob[]) {
    const { data: claims, error: claimError } = await db.rpc("claim_db_job", {
      p_id: candidate.id, p_stale_seconds: STALE_SECONDS,
    });
    if (claimError) throw claimError;
    const job = (claims as DbJob[] | null)?.[0];
    if (!job) continue;
    // Dev uses the same lease heartbeat, token-fenced finish/retry and terminal
    // hook as the distributed runner; never execute an unclaimed pending row.
    await processClaimedJob(db, { "document.extract_text": handleDocumentExtractText }, job, {
      "document.extract_text": markDocumentTextFailed,
    });
  }
}

/** Queue a bounded, resumable batch of missing text, optionally retrying failures. */
export async function backfillDocumentText(db: Db, options: { limit?: number; retryFailed?: boolean } = {}) {
  const { data, error } = await db.rpc("backfill_document_text", {
    p_limit: options.limit ?? 100, p_retry_failed: options.retryFailed ?? false,
  });
  if (error) throw error;
  await processDocumentTextInline(db);
  return Number(data ?? 0);
}
