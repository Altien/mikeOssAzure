import { AppError } from "../../lib/appError";
import { setOperation } from "../../lib/observability/sentry";
import { createHash } from "node:crypto";
import { downloadFile } from "../../lib/storage";
import { EXTRACTION_MAX_BYTES, ExtractionBusyError, ExtractionLimitError, withBackgroundExtraction } from "../../lib/extraction/isolated";
import { withClaimCancellation } from "../../lib/extraction/claimCancellation";
import { DbJobDeferredError, type Db, type DbJob } from "../../lib/dbq/types";
import { processClaimedJob, STALE_SECONDS } from "../../lib/dbq/runner";

export { extractDocumentText } from "../../lib/extraction/documentText";

/** Final202 adapter: canonical queue ownership surrounds isolated parsing, not replaced by it. */
export async function handleDocumentExtractText(db: Db, job: DbJob): Promise<void> {
  setOperation("documents.extract");
  const { versionId, revision } = job.payload;
  if (typeof versionId !== "string" || typeof revision !== "string" || !job.claim_token) return;
  const identity = { p_job_id: job.id, p_attempt: job.attempts, p_token: job.claim_token,
    p_version_id: versionId, p_revision: revision };
  try {
    await withClaimCancellation(db, job, async (signal, assertCurrent) => {
      await withBackgroundExtraction({ waitMs: 60_000, signal }, async extract => {
        const { data: version, error } = await db.from("document_versions")
          .select("id,storage_path,file_type,filename,content_sha256,text_revision,size_bytes")
          .eq("id", versionId).eq("text_revision", revision).is("deleted_at", null).maybeSingle();
        if (error) throw error;
        if (!version?.storage_path) return;
        const { data: claimed, error: claimError } = await db.rpc("claim_document_text_job", identity);
        if (claimError) throw claimError;
        if (claimed !== true) return;
        if ((version.size_bytes ?? 0) > EXTRACTION_MAX_BYTES) {
          await markDocumentTextFailed(db, job, "too_large", true); return;
        }
        await assertCurrent();
        //203 provider adapters settle abort/deadline so this admission's finally releases.
        const raw = await downloadFile(version.storage_path, signal);
        if (!raw) throw new Error("document_text_source_unavailable");
        const hash = createHash("sha256").update(Buffer.from(raw)).digest("hex");
        if (version.content_sha256 && version.content_sha256 !== hash) throw new Error("document_text_source_changed");
        let extracted: { text: string; textlessPageCount: number | null };
        try {
          await assertCurrent();
          extracted = await extract("documentText", raw, { fileType: version.file_type || version.filename?.split(".").pop() || "", signal });
        } catch (error) {
          if (!(error instanceof ExtractionLimitError)) throw error;
          await markDocumentTextFailed(db, job, "too_large", true); return;
        }
        signal.throwIfAborted();
        const { error: publishError } = await db.rpc("publish_document_text", { ...identity,
          p_text: extracted.text.replaceAll("\0", ""), p_sha256: hash, p_textless_pages: extracted.textlessPageCount });
        if (publishError) throw publishError;
      });
    });
  } catch (error) {
    if (error instanceof ExtractionBusyError)
      throw new DbJobDeferredError(new Date(Date.now()+30_000).toISOString(), "document_extraction_busy");
    throw error;
  }
}
export async function markDocumentTextFailed(db: Db, job: DbJob, errorCode = "extraction_failed", running = false): Promise<void> {
  const { versionId, revision } = job.payload;
  if (typeof versionId !== "string" || typeof revision !== "string" || !job.claim_token) return;
  const { error } = await db.rpc("fail_document_text_job", { p_job_id: job.id, p_attempt: job.attempts, p_token: job.claim_token,
    p_version_id: versionId, p_revision: revision, p_error_code: errorCode, p_running: running });
  if (error) throw error;
}
/** Preserve Dev's real UUID claim/runner escape hatch, including deferred claims. */
export async function processDocumentTextInline(db: Db, versionIds?: string[]) {
  if (process.env.DB_JOBS_ENABLED !== "false") return;
  let query = db.from("db_jobs").select("*").eq("kind", "document.extract_text").eq("status", "pending");
  if (versionIds?.length) query = query.in("payload->>versionId", versionIds);
  const { data, error } = await query.order("created_at").limit(versionIds?.length ?? 5);
  if (error) throw error;
  for (const candidate of (data ?? []) as DbJob[]) {
    const { data: claims, error: claimError } = await db.rpc("claim_db_job", { p_id: candidate.id, p_stale_seconds: STALE_SECONDS });
    if (claimError) throw claimError;
    const job = (claims as DbJob[] | null)?.[0];
    if (!job) continue;
    await processClaimedJob(db, { "document.extract_text": handleDocumentExtractText }, job, { "document.extract_text": markDocumentTextFailed });
  }
}
export async function backfillDocumentText(db: Db, options: { limit?: number; retryFailed?: boolean } = {}) {
  const { data, error } = await db.rpc("backfill_document_text", { p_limit: options.limit ?? 100, p_retry_failed: options.retryFailed ?? false });
  if (error) throw error;
  await processDocumentTextInline(db);
  return Number(data ?? 0);
}
