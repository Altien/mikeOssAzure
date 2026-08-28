import { randomUUID } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";

import { ensureDocAccess, checkProjectAccess } from "../lib/access";
import { sendInternalError } from "../lib/httpError";
import { uploadSessionRateLimitConfiguration } from "../lib/runtimeConfig";
import {
  copyFile,
  getSignedUploadUrl,
  headFile,
  StorageOperationError,
  storageEnabled,
  uploadTransport,
  stageUploadPart,
  sealUploadParts,
} from "../lib/storage";
import { createServerSupabase } from "../lib/supabase";
import {
  parseUploadSessionRequest,
  uploadSessionExpiresAt,
  UploadSessionValidationError,
  UPLOAD_URL_TTL_SECONDS,
  type ParsedUploadSessionRequest,
  type UploadSessionFile,
} from "../lib/uploadSessions";
import { requireAuth } from "../middleware/auth";

export const uploadSessionsRouter = Router();

const uploadRateLimits = uploadSessionRateLimitConfiguration();

const uploadSessionMutationLimiter = rateLimit({
  windowMs: uploadRateLimits.mutationWindowMinutes * 60 * 1000,
  max: uploadRateLimits.mutationMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (_req, res) => String(res.locals.userId),
  message: {
    code: "upload_session_control_rate_limit",
    detail: "Too many upload requests. Please try again later.",
  },
});

// Key by the authenticated user, not the caller-supplied session id, so random
// path segments cannot create unlimited limiter buckets. The client backs off
// status polling, while this independent ceiling protects the API from abuse.
const uploadSessionPollingLimiter = rateLimit({
  windowMs: uploadRateLimits.pollingWindowMinutes * 60 * 1000,
  max: uploadRateLimits.pollingMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (_req, res) => String(res.locals.userId),
  message: {
    code: "upload_session_poll_rate_limit",
    detail: "Upload status was checked too often. Please try again shortly.",
  },
});

const uploadPartLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // A full 2 GiB session has 256 chunks; allow three bounded retries plus
  // ordinary use without the generic JSON-control limiter cutting it short.
  max: 1024,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (_req, res) => String(res.locals.userId),
});

const sessionIdSchema = z.string().uuid();
const UPLOAD_PART_BYTES = 8 * 1024 * 1024;
const partIndexSchema = z.coerce.number().int().min(0).max(12);
function partBlockId(claimToken: string): string {
  return Buffer.from(claimToken.replace(/-/g, ""), "hex").toString("base64");
}
const fileCompletionRequestSchema = z
  .object({ failed: z.boolean().default(false) })
  .strict();

uploadSessionsRouter.param("sessionId", (_req, res, next, value) => {
  if (!sessionIdSchema.safeParse(value).success) {
    return void res.status(404).json({ detail: "Upload session not found" });
  }
  next();
});

uploadSessionsRouter.param("fileId", (_req, res, next, value) => {
  if (!sessionIdSchema.safeParse(value).success) {
    return void res.status(404).json({ detail: "Upload file not found" });
  }
  next();
});

type Db = ReturnType<typeof createServerSupabase>;
type AsyncRoute = (req: Request, res: Response) => Promise<unknown>;

type UploadSessionRow = {
  id: string;
  user_id: string;
  user_email: string | null;
  purpose: string;
  destination: Record<string, unknown>;
  expected_file_count: number;
  expected_total_bytes: number;
  status: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

type UploadSessionFileRow = UploadSessionFile & {
  session_id: string;
  upload_transport: "direct" | "authenticated_parts";
  upload_generation: string;
  verification_token: string | null;
  verification_lease_until: string | null;
  observed_size_bytes: number | null;
  etag: string | null;
  status: string;
  error_code: string | null;
  result: unknown;
  created_at: string;
  updated_at: string;
};

function asyncRoute(handler: AsyncRoute) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

function publicFile(file: UploadSessionFileRow | UploadSessionFile) {
  return {
    id: file.id,
    resource_id: file.resource_id,
    client_id: file.client_id,
    filename: file.filename,
    target_folder_id: file.target_folder_id,
    file_type: file.file_type,
    content_type: file.content_type,
    expected_size_bytes: file.expected_size_bytes,
    observed_size_bytes:
      "observed_size_bytes" in file ? file.observed_size_bytes : null,
    status: "status" in file ? file.status : "pending_upload",
    error_code: "error_code" in file ? file.error_code : null,
    result: "result" in file ? file.result : null,
  };
}

export async function validateDestinationAccess(
  manifest: ParsedUploadSessionRequest,
  userId: string,
  userEmail: string | undefined,
  db: Db,
  res: Response,
): Promise<boolean> {
  const destination = manifest.destination as Record<string, unknown>;

  if (manifest.purpose === "document_create") {
    if (destination.scope === "standalone") return true;
    if (destination.scope === "workflow") {
      const workflowId = destination.workflow_id as string;
      const { data: workflow, error } = await db
        .from("workflows")
        .select("id, user_id, type")
        .eq("id", workflowId)
        .maybeSingle();
      if (error) {
        sendInternalError(res, error);
        return false;
      }
      if (!workflow || workflow.type !== "assistant") {
        res.status(404).json({ detail: "Workflow not found or not editable" });
        return false;
      }
      if (workflow.user_id === userId) return true;
      const normalizedEmail = (userEmail ?? "").trim().toLowerCase();
      if (!normalizedEmail) {
        res.status(404).json({ detail: "Workflow not found or not editable" });
        return false;
      }
      const { data: share, error: shareError } = await db
        .from("workflow_shares")
        .select("allow_edit")
        .eq("workflow_id", workflowId)
        .eq("shared_with_email", normalizedEmail)
        .maybeSingle();
      if (shareError) {
        sendInternalError(res, shareError);
        return false;
      }
      if (share?.allow_edit === true) return true;
      res.status(404).json({ detail: "Workflow not found or not editable" });
      return false;
    }
    if (destination.scope === "project") {
      const projectId = destination.project_id as string;
      const access = await checkProjectAccess(projectId, userId, userEmail, db);
      if (!access.ok) {
        res.status(404).json({ detail: "Project not found" });
        return false;
      }
      const folderIds = Array.from(
        new Set(
          [
            destination.folder_id as string | null | undefined,
            ...manifest.files.map((file) => file.target_folder_id),
          ].filter((value): value is string => !!value),
        ),
      );
      if (folderIds.length) {
        const { data, error } = await db
          .from("project_subfolders")
          .select("id")
          .eq("project_id", projectId)
          .in("id", folderIds);
        if (error) {
          sendInternalError(res, error);
          return false;
        }
        if ((data ?? []).length !== folderIds.length) {
          res.status(404).json({ detail: "Folder not found" });
          return false;
        }
      }
      return true;
    }

    const folderIds = Array.from(
      new Set(
        [
          destination.folder_id as string | null | undefined,
          ...manifest.files.map((file) => file.target_folder_id),
        ].filter((value): value is string => !!value),
      ),
    );
    if (!folderIds.length) return true;
    const { data, error } = await db
      .from("library_folders")
      .select("id")
      .eq("user_id", userId)
      .eq("library_kind", destination.library_kind as string)
      .in("id", folderIds);
    if (error) {
      sendInternalError(res, error);
      return false;
    }
    if ((data ?? []).length !== folderIds.length) {
      res.status(404).json({ detail: "Folder not found" });
      return false;
    }
    return true;
  }

  if (
    manifest.purpose === "document_version_create" ||
    manifest.purpose === "document_version_replace"
  ) {
    const documentId = destination.document_id as string;
    const { data: document, error } = await db
      .from("documents")
      .select("id, user_id, project_id, workflow_id")
      .eq("id", documentId)
      .maybeSingle();
    if (error) {
      sendInternalError(res, error);
      return false;
    }
    if (!document) {
      res.status(404).json({ detail: "Document not found" });
      return false;
    }
    const access = await ensureDocAccess(document, userId, userEmail, db);
    const canReplace =
      access.ok &&
      (access.isOwner || (Boolean(document.workflow_id) && access.canEdit));
    if (
      !access.ok ||
      !access.canEdit ||
      (manifest.purpose === "document_version_replace" && !canReplace)
    ) {
      res.status(404).json({ detail: "Document not found" });
      return false;
    }
    if (manifest.purpose === "document_version_create") return true;

    const { data: version, error: versionError } = await db
      .from("document_versions")
      .select("id, file_type, deleted_at")
      .eq("id", destination.version_id as string)
      .eq("document_id", documentId)
      .maybeSingle();
    if (versionError) {
      sendInternalError(res, versionError);
      return false;
    }
    if (!version || version.deleted_at) {
      res.status(404).json({ detail: "Version not found" });
      return false;
    }
    if (
      version.file_type &&
      version.file_type !== manifest.files[0].file_type
    ) {
      res.status(400).json({
        detail: `Uploaded file type (${manifest.files[0].file_type}) does not match version type (${version.file_type}).`,
      });
      return false;
    }
    return true;
  }

  const workflowId = destination.workflow_id as string;
  const { data: workflow, error } = await db
    .from("workflows")
    .select("id, user_id, type")
    .eq("id", workflowId)
    .maybeSingle();
  if (error) {
    sendInternalError(res, error);
    return false;
  }
  if (!workflow) {
    res.status(404).json({ detail: "Workflow not found or not editable" });
    return false;
  }

  let canEdit = workflow.user_id === userId;
  if (!canEdit && userEmail) {
    const { data: share, error: shareError } = await db
      .from("workflow_shares")
      .select("allow_edit")
      .eq("workflow_id", workflowId)
      .eq("shared_with_email", userEmail.trim().toLowerCase())
      .maybeSingle();
    if (shareError) {
      sendInternalError(res, shareError);
      return false;
    }
    canEdit = share?.allow_edit === true;
  }
  if (!canEdit) {
    res.status(404).json({ detail: "Workflow not found or not editable" });
    return false;
  }
  if (workflow.type === "tabular") {
    res.status(400).json({
      detail: "Assets are only supported for assistant workflows",
    });
    return false;
  }

  // Compatibility validation for in-flight sessions created by the previous
  // release. New clients use document_version_create.
  if (manifest.purpose === "workflow_reference_replace") {
    const { data: asset, error: assetError } = await db
      .from("documents")
      .select("id")
      .eq("id", destination.reference_id as string)
      .eq("workflow_id", workflowId)
      .maybeSingle();
    if (assetError) {
      sendInternalError(res, assetError);
      return false;
    }
    if (!asset) {
      res.status(404).json({ detail: "Asset not found" });
      return false;
    }
  }
  return true;
}

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

function signedUrlTtl(expiresAt: string): number {
  const remainingSeconds = Math.floor(
    (new Date(expiresAt).getTime() - Date.now()) / 1000,
  );
  return Math.max(1, Math.min(UPLOAD_URL_TTL_SECONDS, remainingSeconds));
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

// Blob is private to the backend's managed identity. Each authenticated chunk
// is claimed before streaming; a late, timed-out request stages under its own
// block ID and cannot replace a newer receipt or sealed object.
uploadSessionsRouter.put(
  "/:sessionId/files/:fileId/parts/:partIndex",
  requireAuth,
  uploadPartLimiter,
  asyncRoute(async (req, res) => {
    if (uploadTransport() !== "authenticated_parts") {
      return void res.status(404).json({ detail: "Upload part not found" });
    }
    const partIndex = partIndexSchema.safeParse(req.params.partIndex);
    const generation = sessionIdSchema.safeParse(req.header("X-Upload-Generation"));
    const contentLength = Number(req.header("Content-Length"));
    if (!partIndex.success || !generation.success || !Number.isSafeInteger(contentLength)
      || contentLength < 1 || contentLength > UPLOAD_PART_BYTES
      || req.header("Content-Type") !== "application/octet-stream") {
      return void res.status(400).json({ detail: "Invalid upload part" });
    }
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const session = await loadOwnedSession(db, req.params.sessionId, userId);
    if (!session) return void res.status(404).json({ detail: "Upload session not found" });
    const file = (await loadSessionFiles(db, session.id)).find((row) => row.id === req.params.fileId);
    if (!file) return void res.status(404).json({ detail: "Upload file not found" });
    const { data: claim, error } = await db.rpc("claim_upload_part", {
      p_session_id: session.id, p_file_id: file.id, p_user_id: userId,
      p_generation: generation.data, p_part_index: partIndex.data, p_size: contentLength,
    });
    if (error) {
      if (/upload_part_(not_allowed|index_invalid|size_invalid)/.test(error.message ?? "")) {
        return void res.status(409).json({ detail: "Upload part is no longer available" });
      }
      return void sendInternalError(res, error);
    }
    if (claim?.status === "completed") return void res.status(200).json({ status: "completed" });
    if (claim?.status !== "claimed" || !sessionIdSchema.safeParse(claim.claim_token).success) {
      return void res.status(409).json({ detail: "Upload part is already in progress" });
    }
    const claimToken = claim.claim_token as string;
    const aborter = new AbortController();
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
        bytes += chunk.length;
        if (bytes > contentLength) callback(new Error("upload_part_too_large"));
        else callback(null, chunk);
      },
    });
    req.on("aborted", () => aborter.abort());
    req.pipe(meter);
    try {
      await stageUploadPart(file.staging_storage_path, partBlockId(claimToken), meter, contentLength, aborter.signal);
      if (bytes !== contentLength || req.aborted) {
        return void res.status(400).json({ detail: "Incomplete upload part" });
      }
      const { data: completed, error: completeError } = await db.rpc("complete_upload_part", {
        p_session_id: session.id, p_file_id: file.id, p_user_id: userId,
        p_generation: generation.data, p_part_index: partIndex.data, p_claim_token: claimToken,
      });
      if (completeError) return void sendInternalError(res, completeError);
      if (!completed) return void res.status(409).json({ detail: "Upload part claim expired" });
      await extendSessionExpiry(db, session.id);
      res.json({ status: "completed" });
    } finally {
      req.unpipe(meter);
      meter.destroy();
    }
  }),
);

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
    const existing = await headFile(file.staging_storage_path);
    if (!existing) {
      await sealUploadParts(file.staging_storage_path, receipts!.map((part) => partBlockId(part.claim_token)), file.content_type);
    }
  }
  const staged = await headFile(file.staging_storage_path);
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
  await copyFile(file.staging_storage_path, candidatePath, staged.etag);
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

uploadSessionsRouter.post(
  "/",
  requireAuth,
  uploadSessionMutationLimiter,
  asyncRoute(async (req, res) => {
    if (!storageEnabled) {
      return void res.status(503).json({ detail: "Storage is not configured" });
    }

    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const sessionId = randomUUID();
    let manifest: ParsedUploadSessionRequest;
    try {
      manifest = parseUploadSessionRequest(req.body, userId, sessionId);
    } catch (error) {
      if (error instanceof UploadSessionValidationError) {
        return void res
          .status(error.status)
          .json({ code: error.code, detail: error.message });
      }
      throw error;
    }

    const db = createServerSupabase();
    if (
      !(await validateDestinationAccess(manifest, userId, userEmail, db, res))
    ) {
      return;
    }

    const expiresAt = uploadSessionExpiresAt();
    const { error } = await db.rpc("create_upload_session", {
      target_session_id: sessionId,
      target_user_id: userId,
      target_purpose: manifest.purpose,
      target_destination: manifest.destination,
      target_expires_at: expiresAt,
      target_files: manifest.files.map((file) => ({ ...file, upload_transport: uploadTransport() })),
      target_hourly_session_limit: uploadRateLimits.sessionCreationMaxPerHour,
      target_user_email: userEmail ?? null,
    });
    if (error) {
      if (error.message?.includes("upload_session_rate_limit_exceeded")) {
        return void res.status(429).json({
          code: "upload_session_rate_limit_exceeded",
          detail: "Too many upload sessions. Please try again later.",
        });
      }
      if (error.message?.includes("upload_target_busy")) {
        return void res.status(409).json({
          code: "upload_target_busy",
          detail: "Another upload is already updating this item.",
        });
      }
      if (
        error.message?.includes("upload_file_count_limit_exceeded") ||
        error.message?.includes("upload_total_size_limit_exceeded") ||
        error.message?.includes("invalid_upload_manifest")
      ) {
        return void res.status(400).json({ detail: "Invalid upload manifest" });
      }
      return void sendInternalError(res, error);
    }

    try {
      const files = await signPendingFiles(await loadSessionFiles(db, sessionId), expiresAt, sessionId);
      res.status(201).json({
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
      });
    } catch (error) {
      await db
        .from("upload_sessions")
        .update({
          status: "cancelled",
          cancelled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", sessionId)
        .eq("user_id", userId);
      return void sendInternalError(res, error, 503);
    }
  }),
);

uploadSessionsRouter.get(
  "/:sessionId",
  requireAuth,
  uploadSessionPollingLimiter,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const session = await loadOwnedSession(db, req.params.sessionId, userId);
    if (!session) {
      return void res.status(404).json({ detail: "Upload session not found" });
    }
    const files = await loadSessionFiles(db, session.id);
    res.json({ session, files: files.map(publicFile) });
  }),
);

uploadSessionsRouter.post(
  "/:sessionId/urls",
  requireAuth,
  uploadSessionMutationLimiter,
  asyncRoute(async (req, res) => {
    if (!storageEnabled) {
      return void res.status(503).json({ detail: "Storage is not configured" });
    }
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const session = await loadOwnedSession(db, req.params.sessionId, userId);
    if (!session) {
      return void res.status(404).json({ detail: "Upload session not found" });
    }
    if (session.status !== "pending_upload") {
      return void res.status(409).json({
        detail: "Upload URLs can only be refreshed for a pending session",
      });
    }
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      await db
        .from("upload_sessions")
        .update({ status: "expired", updated_at: new Date().toISOString() })
        .eq("id", session.id)
        .eq("status", "pending_upload");
      return void res.status(410).json({ detail: "Upload session expired" });
    }

    // Recover only expired verification leases. Active claims and their
    // immutable candidates stay untouched; part receipts remain resumable.
    const { error: reclaimError } = await db.rpc("reclaim_expired_upload_verifications", {
      p_session_id: session.id, p_user_id: userId,
    });
    if (reclaimError) return void sendInternalError(res, reclaimError);
    const pendingFiles = (await loadSessionFiles(db, session.id))
      .filter((file) => file.status === "pending_upload");
    res.json({
      files: await signPendingFiles(pendingFiles, session.expires_at, session.id),
    });
  }),
);

uploadSessionsRouter.post(
  "/:sessionId/files/:fileId/complete",
  requireAuth,
  uploadSessionMutationLimiter,
  asyncRoute(async (req, res) => {
    if (!storageEnabled) {
      return void res.status(503).json({ detail: "Storage is not configured" });
    }
    const parsed = fileCompletionRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return void res
        .status(400)
        .json({ detail: "Invalid completion request" });
    }
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const session = await loadOwnedSession(db, req.params.sessionId, userId);
    if (!session) {
      return void res.status(404).json({ detail: "Upload session not found" });
    }
    if (["cancelled", "expired"].includes(session.status)) {
      return void res
        .status(409)
        .json({ detail: "Upload session is not active" });
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
      return void res.status(410).json({ detail: "Upload session expired" });
    }
    const files = await loadSessionFiles(db, session.id);
    const file = files.find((candidate) => candidate.id === req.params.fileId);
    if (!file) {
      return void res.status(404).json({ detail: "Upload file not found" });
    }

    try {
      const result = await completeSessionFile(
        db,
        session,
        file,
        userId,
        parsed.data.failed,
      );
      const updated = await loadOwnedSession(db, session.id, userId);
      const currentFiles = await loadSessionFiles(db, session.id);
      if (result === "incomplete") {
        return void res.status(409).json({
          code: "upload_incomplete",
          detail: "The uploaded file is not available yet.",
          session: updated,
          files: currentFiles.map(publicFile),
        });
      }
      res.status(result === "in_progress" ? 202 : 200).json({
        session: updated,
        files: currentFiles.map(publicFile),
      });
    } catch (error) {
      if (error instanceof StorageOperationError) {
        return void sendInternalError(res, error, 503);
      }
      throw error;
    }
  }),
);

uploadSessionsRouter.delete(
  "/:sessionId",
  requireAuth,
  uploadSessionMutationLimiter,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const session = await loadOwnedSession(db, req.params.sessionId, userId);
    if (!session) {
      return void res.status(404).json({ detail: "Upload session not found" });
    }
    const { data: cancelled, error } = await db.rpc("cancel_upload_session", {
      p_session_id: session.id, p_user_id: userId,
    });
    if (error) return void sendInternalError(res, error);
    if (!cancelled) {
      return void res.status(409).json({
        detail:
          "Upload session is already being completed and cannot be cancelled",
      });
    }

    res.status(204).end();
  }),
);
