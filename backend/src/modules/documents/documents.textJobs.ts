// Compatibility entrypoint for existing precompute jobs; canonical revision-aware text owns publication.
import type { Db, DbJob } from "../../lib/dbq/types";
import { requiresLibreOfficeTextExtraction } from "../../lib/documentTypes";
import { processDocumentTextInline } from "./documents.indexing";

export async function handleDocumentPrecomputeText(db: Db, job: DbJob): Promise<void> {
  const { versionId, storagePath, fileType } = job.payload;
  if (typeof versionId !== "string" || typeof storagePath !== "string" || typeof fileType !== "string" || !requiresLibreOfficeTextExtraction(fileType)) return;
  if (!job.claim_token) throw new Error("Document precompute job has no claim fence");
  const { error } = await db.rpc("queue_document_text", {
    p_version_id: versionId, p_retry_failed: false,
    p_precompute_job: { id: job.id, attempt: job.attempts, token: job.claim_token },
  });
  if (error) throw error;
  // Legacy rows become real canonical jobs even in escape-hatch deployments.
  // No fixed version-only cache is written or trusted.
  await processDocumentTextInline(db, [versionId]);
}
