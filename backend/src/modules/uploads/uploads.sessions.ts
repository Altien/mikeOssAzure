// Upload-session control plane for private Azure parts and direct R2 objects.
//
// Every function here takes an explicit `db` and returns a value or an
// `UploadFailure`; uploads.routes.ts maps those onto status codes. Private
// Azure bytes stream through an authenticated route into claim-specific
// blocks; direct R2 still uses size/type-bound signed URLs.
//
// SQL claim tokens, upload generations and leases fence all receipts and
// verification results before an immutable candidate becomes visible.

import { Transform, type TransformCallback, type Readable } from "node:stream";

import {
  copyFile,
  getSignedUploadUrl,
  headFile,
  StorageOperationError,
  uploadTransport,
  stageUploadPart,
  sealUploadParts,
} from "../../lib/storage";
import type { Db } from "../../lib/supabase";
import {
  uploadSessionExpiresAt,
  UPLOAD_URL_TTL_SECONDS,
  UPLOAD_PART_BYTES,
  type ParsedUploadSessionRequest,
  type UploadSessionFile,
} from "./uploads.manifest";
import {
  failure,
  internalFailure,
  publicFile,
  type UploadResult,
  type UploadSessionFileRow,
  type UploadSessionRow,
} from "./uploads.shared";

// ---------------------------------------------------------------------------
// Row loading
// ---------------------------------------------------------------------------

async function loadOwnedSession(
  db: Db,
  sessionId: string,
  userId: string,
): Promise<UploadSessionRow | null> {
  const { data, error } = await db
    .from("upload_sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as UploadSessionRow | null) ?? null;
}

async function loadSessionFiles(
  db: Db,
  sessionId: string,
): Promise<UploadSessionFileRow[]> {
  const { data, error } = await db
    .from("upload_session_files")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as UploadSessionFileRow[];
}

// ---------------------------------------------------------------------------
// Signed URLs
// ---------------------------------------------------------------------------

function signedUrlTtl(expiresAt: string): number {
  const remainingSeconds = Math.floor(
    (new Date(expiresAt).getTime() - Date.now()) / 1000,
  );
  return Math.max(1, Math.min(UPLOAD_URL_TTL_SECONDS, remainingSeconds));
}

function partBlockId(claimToken: string): string {
  return Buffer.from(claimToken.replace(/-/g, ""), "hex").toString("base64");
}

function partStagingPath(file: UploadSessionFileRow): string {
  // A reclaimed session may use a new generation while a previous verifier
  // is still in object storage. Separate blobs prevent that stale verifier
  // from committing its old block list over the new generation's bytes.
  return `${file.staging_storage_path}/generations/${file.upload_generation}`;
}

async function signPendingFiles(
  files: Array<UploadSessionFileRow | UploadSessionFile>,
  expiresAt: string,
  sessionId: string,
) {
  const ttl = signedUrlTtl(expiresAt);
  return await Promise.all(
    files.map(async (file) => {
      if (uploadTransport() === "authenticated_parts") {
        const persisted = file as UploadSessionFileRow;
        return {
          ...publicFile(file),
          upload: {
            transport: "authenticated_parts" as const,
            method: "PUT" as const,
            path: `/upload-sessions/${sessionId}/files/${file.id}/parts`,
            generation: persisted.upload_generation,
            chunk_size: UPLOAD_PART_BYTES,
            expires_at: expiresAt,
          },
        };
      }
      const url = await getSignedUploadUrl(
        file.staging_storage_path,
        file.content_type,
        file.expected_size_bytes,
        ttl,
      );
      if (!url) throw new Error("Failed to create signed upload URL");
      return {
        ...publicFile(file),
        upload: {
          transport: "direct" as const,
          method: "PUT" as const,
          url,
          // Content-Length is part of the signature but is deliberately absent
          // here: browsers set it from the body and refuse a manual override,
          // so a wrong-size body fails signature validation at the store.
          headers: { "Content-Type": file.content_type },
          expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
        },
      };
    }),
  );
}

/** Stream one private Azure chunk under its claim-specific block ID. */
export async function putAuthenticatedUploadPart(
  db: Db,
  args: {
    sessionId: string;
    fileId: string;
    userId: string;
    generation: string;
    partIndex: number;
    contentLength: number;
    body: Readable;
  },
): Promise<UploadResult<{ status: "completed" }>> {
  if (uploadTransport() !== "authenticated_parts")
    return failure(404, { detail: "Upload part not found" });
  const session = await loadOwnedSession(db, args.sessionId, args.userId);
  if (!session) return failure(404, { detail: "Upload session not found" });
  const file = (await loadSessionFiles(db, session.id)).find((row) => row.id === args.fileId);
  if (!file) return failure(404, { detail: "Upload file not found" });
  const { data: claim, error } = await db.rpc("claim_upload_part", {
    p_session_id: session.id, p_file_id: file.id, p_user_id: args.userId,
    p_generation: args.generation, p_part_index: args.partIndex, p_size: args.contentLength,
  });
  if (error) {
    if (/upload_part_(not_allowed|index_invalid|size_invalid)/.test(error.message ?? ""))
      return failure(409, { detail: "Upload part is no longer available" });
    return internalFailure(error);
  }
  if (claim?.status === "completed") return { ok: true, data: { status: "completed" } };
  const claimToken = typeof claim?.claim_token === "string" ? claim.claim_token : "";
  if (claim?.status !== "claimed" || !/^[0-9a-f-]{36}$/i.test(claimToken))
    return failure(409, { detail: "Upload part is already in progress" });

  const aborter = new AbortController();
  let bytes = 0;
  let aborted = false;
  const onAbort = () => { aborted = true; aborter.abort(); };
  const meter = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      bytes += chunk.length;
      callback(bytes > args.contentLength ? new Error("upload_part_too_large") : null, chunk);
    },
  });
  args.body.on("aborted", onAbort);
  args.body.pipe(meter);
  try {
    await stageUploadPart(partStagingPath(file), partBlockId(claimToken), meter,
      args.contentLength, aborter.signal);
    if (bytes !== args.contentLength || aborted)
      return failure(400, { detail: "Incomplete upload part" });
    const { data: completed, error: completeError } = await db.rpc("complete_upload_part", {
      p_session_id: session.id, p_file_id: file.id, p_user_id: args.userId,
      p_generation: args.generation, p_part_index: args.partIndex, p_claim_token: claimToken,
    });
    if (completeError) return internalFailure(completeError);
    if (!completed) return failure(409, { detail: "Upload part claim expired" });
    await extendSessionExpiry(db, session.id);
    return { ok: true, data: { status: "completed" } };
  } finally {
    args.body.off("aborted", onAbort);
    args.body.unpipe(meter);
    meter.destroy();
  }
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

async function verifyAndSealSessionFiles(
  db: Db,
  session: UploadSessionRow,
  file: UploadSessionFileRow,
  userId: string,
  token: string,
): Promise<boolean> {
  const finish = async (status: string, observedSize: number | null = null,
    etag: string | null = null, sealedPath: string | null = null,
    errorCode: string | null = null): Promise<boolean> => {
    const { data, error } = await db.rpc("finish_upload_verification", {
      p_session_id: session.id, p_file_id: file.id, p_user_id: userId,
      p_claim_token: token, p_status: status, p_observed_size: observedSize,
      p_etag: etag, p_sealed_path: sealedPath, p_error_code: errorCode,
    });
    if (error) throw error;
    return data === true;
  };

  if (file.upload_transport === "authenticated_parts") {
    const { data: receipts, error } = await db.from("upload_session_parts")
      .select("part_index, claim_token, size_bytes")
      .eq("file_id", file.id).eq("generation", file.upload_generation)
      .eq("status", "completed").order("part_index", { ascending: true });
    if (error) throw error;
    const expected = Math.ceil(file.expected_size_bytes / UPLOAD_PART_BYTES);
    if ((receipts ?? []).length !== expected || receipts?.some((part, index) => part.part_index !== index)) {
      return await finish("pending_upload");
    }
    // Always commit the current generation's receipt list. An old blob at
    // this path is never evidence that the present receipt set was sealed.
    await sealUploadParts(partStagingPath(file), receipts!.map((part) => partBlockId(part.claim_token)), file.content_type);
  }
  const stagingPath = file.upload_transport === "authenticated_parts"
    ? partStagingPath(file) : file.staging_storage_path;
  const staged = await headFile(stagingPath);
  if (!staged) return await finish("pending_upload");
  if (staged.size !== file.expected_size_bytes || staged.contentType !== file.content_type) {
    return await finish("error", staged.size, staged.etag, null,
      staged.size !== file.expected_size_bytes ? "size_mismatch" : "content_type_mismatch");
  }
  if (!staged.etag) throw new StorageOperationError("missing staging ETag");

  // Every verifier copies to a unique immutable candidate. Its DB CAS decides
  // which candidate is visible to the worker, so lease expiry cannot publish
  // an old object's bytes over a newer claim.
  const candidatePath = `${file.sealed_storage_path}/claims/${token}`;
  await copyFile(stagingPath, candidatePath, staged.etag);
  const copied = await headFile(candidatePath);
  if (!copied || !copied.etag || copied.size !== file.expected_size_bytes || copied.contentType !== file.content_type) {
    throw new Error("Failed to verify sealed upload object");
  }
  return await finish("uploaded", copied.size, copied.etag, candidatePath);
}

async function refreshSessionStatus(db: Db, sessionId: string): Promise<void> {
  const { error } = await db.rpc("refresh_upload_session_status", {
    target_session_id: sessionId,
  });
  if (error) throw error;
}

/**
 * Slide the session deadline forward as files land. A large batch on a slow
 * uplink can outlive the initial 30-minute TTL; the RPC applies its own
 * absolute cap from session creation, so this cannot extend a session forever.
 * A failure here must never fail an upload that already succeeded.
 */
async function extendSessionExpiry(db: Db, sessionId: string): Promise<void> {
  const { error } = await db.rpc("extend_upload_session_expiry", {
    target_session_id: sessionId,
  });
  if (error) {
    console.error("[upload-sessions] extending the session expiry failed", {
      sessionId,
      error,
    });
  }
}

async function queueFileProcessing(
  db: Db,
  sessionId: string,
  userId: string,
  fileId: string,
): Promise<string> {
  const { data, error } = await db.rpc("queue_upload_session_file_processing", {
    target_session_id: sessionId,
    target_user_id: userId,
    target_file_id: fileId,
  });
  if (error) throw error;
  if (typeof data !== "string" || !data) {
    throw new Error("Upload processing job was not created");
  }
  return data;
}

type FileCompletionResult = "resolved" | "incomplete" | "in_progress";

async function completeSessionFile(
  db: Db,
  session: UploadSessionRow,
  file: UploadSessionFileRow,
  userId: string,
  failed: boolean,
): Promise<FileCompletionResult> {
  if (failed) {
    if (file.status === "verifying" && file.verification_lease_until &&
      new Date(file.verification_lease_until).getTime() > Date.now()) return "in_progress";
    if (file.status === "pending_upload" || file.status === "verifying") {
      let failQuery = db
        .from("upload_session_files")
        .update({
          status: "error",
          verification_token: null,
          verification_lease_until: null,
          error_code: "upload_failed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", file.id)
        .eq("session_id", session.id)
        .eq("status", file.status)
        .eq("upload_generation", file.upload_generation);
      failQuery = file.verification_token
        ? failQuery.eq("verification_token", file.verification_token)
        : failQuery.is("verification_token", null);
      const { error } = await failQuery;
      if (error) throw error;
    }
    await refreshSessionStatus(db, session.id);
    return "resolved";
  }

  if (file.status === "uploaded") {
    await queueFileProcessing(db, session.id, userId, file.id);
    await extendSessionExpiry(db, session.id);
    await refreshSessionStatus(db, session.id);
    return "resolved";
  }
  if (["processing", "completed", "error"].includes(file.status)) {
    await refreshSessionStatus(db, session.id);
    return "resolved";
  }
  if (file.status === "verifying") {
    if (file.verification_lease_until &&
      new Date(file.verification_lease_until).getTime() > Date.now()) return "in_progress";
  }
  const { data: claimed, error: claimError } = await db.rpc("claim_upload_verification", {
    p_session_id: session.id, p_file_id: file.id, p_user_id: userId,
  });
  if (claimError) throw claimError;
  if (!claimed) return file.status === "pending_upload" ? "incomplete" : "in_progress";
  const verified = await verifyAndSealSessionFiles(db, session, file, userId, claimed as string);
  const currentFiles = await loadSessionFiles(db, session.id);
  const current = currentFiles.find((candidate) => candidate.id === file.id);
  if (!verified || current?.status !== "uploaded") {
    await refreshSessionStatus(db, session.id);
    return current?.status === "error" ? "resolved" : "incomplete";
  }
  await queueFileProcessing(db, session.id, userId, file.id);
  await extendSessionExpiry(db, session.id);
  await refreshSessionStatus(db, session.id);
  return "resolved";
}

// ---------------------------------------------------------------------------
// Service entry points
// ---------------------------------------------------------------------------

/**
 * Create the session row and return the signed URLs for its manifest. The
 * hourly ceiling is enforced inside the RPC (one transaction with the insert),
 * so the caller passes its configured limit rather than counting rows first.
 */
export async function createUploadSession(
  db: Db,
  args: {
    sessionId: string;
    userId: string;
    userEmail?: string;
    manifest: ParsedUploadSessionRequest;
    hourlySessionLimit: number;
  },
): Promise<UploadResult<Record<string, unknown>>> {
  const { sessionId, userId, manifest } = args;
  const expiresAt = uploadSessionExpiresAt();
  const { error } = await db.rpc("create_upload_session", {
    target_session_id: sessionId,
    target_user_id: userId,
    target_purpose: manifest.purpose,
    target_destination: manifest.destination,
    target_expires_at: expiresAt,
    target_files: manifest.files.map((file) => ({ ...file, upload_transport: uploadTransport() })),
    target_hourly_session_limit: args.hourlySessionLimit,
    target_user_email: args.userEmail ?? null,
  });
  if (error) {
    if (error.message?.includes("upload_session_rate_limit_exceeded")) {
      return failure(429, {
        code: "upload_session_rate_limit_exceeded",
        detail: "Too many upload sessions. Please try again later.",
      });
    }
    if (error.message?.includes("upload_target_busy")) {
      return failure(409, {
        code: "upload_target_busy",
        detail: "Another upload is already updating this item.",
      });
    }
    if (
      error.message?.includes("upload_file_count_limit_exceeded") ||
      error.message?.includes("upload_total_size_limit_exceeded") ||
      error.message?.includes("invalid_upload_manifest")
    ) {
      return failure(400, { detail: "Invalid upload manifest" });
    }
    return internalFailure(error);
  }

  try {
    const files = await signPendingFiles(await loadSessionFiles(db, sessionId), expiresAt, sessionId);
    return {
      ok: true,
      data: {
        session: {
          id: sessionId,
          purpose: manifest.purpose,
          destination: manifest.destination,
          expected_file_count: manifest.files.length,
          expected_total_bytes: manifest.expected_total_bytes,
          status: "pending_upload",
          expires_at: expiresAt,
        },
        files,
      },
    };
  } catch (error) {
    // The row exists but the client will never get a URL for it. Cancel it so
    // the target is not left "busy" for the next attempt.
    await db
      .from("upload_sessions")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", sessionId)
      .eq("user_id", userId);
    return internalFailure(error, 503);
  }
}

/** The session plus its files, as the client polls them. */
export async function getUploadSession(
  db: Db,
  sessionId: string,
  userId: string,
): Promise<UploadResult<Record<string, unknown>>> {
  const session = await loadOwnedSession(db, sessionId, userId);
  if (!session) return failure(404, { detail: "Upload session not found" });
  const files = await loadSessionFiles(db, session.id);
  return { ok: true, data: { session, files: files.map(publicFile) } };
}

/**
 * Re-sign the files that have not landed yet. Signed URLs are shorter-lived
 * than the session, so a slow batch legitimately comes back for more.
 */
export async function refreshUploadUrls(
  db: Db,
  sessionId: string,
  userId: string,
): Promise<UploadResult<Record<string, unknown>>> {
  const session = await loadOwnedSession(db, sessionId, userId);
  if (!session) return failure(404, { detail: "Upload session not found" });
  if (session.status !== "pending_upload") {
    return failure(409, {
      detail: "Upload URLs can only be refreshed for a pending session",
    });
  }
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await db
      .from("upload_sessions")
      .update({ status: "expired", updated_at: new Date().toISOString() })
      .eq("id", session.id)
      .eq("status", "pending_upload");
    return failure(410, { detail: "Upload session expired" });
  }

  // The SQL lease and generation gate make this safe across replicas. Do not
  // reset a live verification claim or discard resumable part receipts.
  const { error: reclaimError } = await db.rpc("reclaim_expired_upload_verifications", {
    p_session_id: session.id, p_user_id: userId,
  });
  if (reclaimError) return internalFailure(reclaimError);
  const pendingFiles = (await loadSessionFiles(db, session.id))
    .filter((file) => file.status === "pending_upload");
  return {
    ok: true,
    data: { files: await signPendingFiles(pendingFiles, session.expires_at, session.id) },
  };
}

/**
 * The client reports one file as uploaded (or as failed). Seal it, queue its
 * processing job, and answer with the session's current state. `status` is the
 * HTTP status the route should use: 202 while another request still holds the
 * verification claim, 200 once this file is resolved.
 */
export async function completeUploadSessionFile(
  db: Db,
  args: {
    sessionId: string;
    fileId: string;
    userId: string;
    failed: boolean;
  },
): Promise<UploadResult<{ status: number; body: Record<string, unknown> }>> {
  const { sessionId, fileId, userId, failed } = args;
  const session = await loadOwnedSession(db, sessionId, userId);
  if (!session) return failure(404, { detail: "Upload session not found" });
  if (["cancelled", "expired"].includes(session.status)) {
    return failure(409, { detail: "Upload session is not active" });
  }
  if (
    session.status === "pending_upload" &&
    new Date(session.expires_at).getTime() <= Date.now()
  ) {
    await db
      .from("upload_sessions")
      .update({ status: "expired", updated_at: new Date().toISOString() })
      .eq("id", session.id)
      .eq("status", "pending_upload");
    return failure(410, { detail: "Upload session expired" });
  }
  const files = await loadSessionFiles(db, session.id);
  const file = files.find((candidate) => candidate.id === fileId);
  if (!file) return failure(404, { detail: "Upload file not found" });

  try {
    const result = await completeSessionFile(db, session, file, userId, failed);
    const updated = await loadOwnedSession(db, session.id, userId);
    const currentFiles = await loadSessionFiles(db, session.id);
    if (result === "incomplete") {
      return failure(409, {
        code: "upload_incomplete",
        detail: "The uploaded file is not available yet.",
        session: updated,
        files: currentFiles.map(publicFile),
      });
    }
    return {
      ok: true,
      data: {
        status: result === "in_progress" ? 202 : 200,
        body: { session: updated, files: currentFiles.map(publicFile) },
      },
    };
  } catch (error) {
    // Object storage being unreachable is not the caller's fault and is worth
    // retrying, so it answers 503 rather than the generic 500.
    if (error instanceof StorageOperationError) {
      return internalFailure(error, 503);
    }
    throw error;
  }
}

/**
 * Cancel a session and drop the objects it staged. Only a pending session —
 * or one whose verification lease has gone stale — can be cancelled: files
 * already handed to the worker must not have their bytes pulled away.
 */
export async function cancelUploadSession(
  db: Db,
  sessionId: string,
  userId: string,
): Promise<UploadResult<null>> {
  const session = await loadOwnedSession(db, sessionId, userId);
  if (!session) return failure(404, { detail: "Upload session not found" });
  const { data: cancelled, error } = await db.rpc("cancel_upload_session", {
    p_session_id: session.id, p_user_id: userId,
  });
  if (error) return internalFailure(error);
  if (!cancelled) {
    return failure(409, {
      detail:
        "Upload session is already being completed and cannot be cancelled",
    });
  }

  return { ok: true, data: null };
}
