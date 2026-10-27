import { createHash } from "node:crypto";
import { downloadFile } from "../../lib/storage";
import { EXTRACTION_MAX_BYTES, ExtractionLimitError, runIsolatedExtraction } from "../../lib/extraction/isolated";
import type { Db, DbJob } from "../../lib/dbq/types";
import { processClaimedJob, STALE_SECONDS } from "../../lib/dbq/runner";

export { extractDocumentText } from "../../lib/extraction/documentText";

/** Extract and publish only while the queued version revision still matches. */
export async function handleDocumentExtractText(db: Db, job: DbJob): Promise<void> {
  const { versionId, revision } = job.payload;
  if (typeof versionId !== "string" || typeof revision !== "string") return;
  const { data: version, error } = await db.from("document_versions")
    .select("id,storage_path,file_type,filename,content_sha256,text_revision,size_bytes")
    .eq("id", versionId).eq("text_revision", revision).is("deleted_at", null).maybeSingle();
  if (error) throw error;
  if (!version?.storage_path) return; // superseded/deleted work is a successful no-op
  if (!job.claim_token) throw new Error("Document text job has no claim fence");
  const identity = { p_job_id: job.id,p_attempt: job.attempts,p_token: job.claim_token,
    p_version_id: versionId,p_revision: revision };
  const { data: claim,error: claimError } = await db.rpc("claim_document_text_job",identity);
  if (claimError) throw claimError;
  if (claim !== true) return; // stale/cancelled/deleted/replaced claim
  if ((version.size_bytes ?? 0) > EXTRACTION_MAX_BYTES) { await markDocumentTextFailed(db, job, "too_large", true); return; }
  const raw = await downloadFile(version.storage_path);
  if (!raw) throw new Error("document_text_source_unavailable");
  const hash = createHash("sha256").update(Buffer.from(raw)).digest("hex");
  if (version.content_sha256 && version.content_sha256 !== hash) throw new Error("document_text_source_changed");
  let extracted: { text: string; textlessPageCount: number | null };
  try { extracted = await runIsolatedExtraction("documentText", raw, { fileType: version.file_type || version.filename?.split(".").pop() || "" }); }
  catch (error) { if (!(error instanceof ExtractionLimitError)) throw error; await markDocumentTextFailed(db, job, "too_large", true); return; }
  const { text, textlessPageCount } = extracted;
  const { error: publishError } = await db.rpc("publish_document_text", {
    ...identity,
    // PostgreSQL text cannot contain NUL; do not truncate otherwise.
    p_text: text.replaceAll("\0", ""), p_sha256: hash, p_textless_pages: textlessPageCount,
  });
  if (publishError) throw publishError;
}

/** Mark exhausted work failed without overwriting a newer revision or ready text. */
export async function markDocumentTextFailed(db: Db, job: DbJob, errorCode = "extraction_failed", running = false): Promise<void> {
  const { versionId,revision } = job.payload;
  if (typeof versionId !== "string" || typeof revision !== "string" || !job.claim_token) return;
  const { error } = await db.rpc("fail_document_text_job", {
    p_job_id: job.id,p_attempt: job.attempts,p_token: job.claim_token,
    p_version_id: versionId,p_revision: revision,p_error_code: errorCode,p_running: running,
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
