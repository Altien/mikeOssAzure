// HTTP layer for the uploads module.
//
// Handlers here own only what is genuinely HTTP: the two rate limiters, the
// uuid param guards, the zod body parse, the storage-configured gate, and the
// mapping of a service result onto a status code and JSON body. Every query,
// storage call, and state transition lives behind uploads.service.ts.
//
// Private Azure Blob parts stream through this authenticated router; direct
// R2 uploads use constrained signed URLs. app.ts bypasses JSON parsing only
// for the bounded part route, so no large upload body is buffered by Express.

import { randomUUID } from "node:crypto";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { Router, type Response } from "express";

import { sendInternalError } from "../../lib/httpError";
import { uploadSessionRateLimitConfiguration } from "../../lib/runtimeConfig";
import { storageEnabled } from "../../lib/storage";
import { createServerSupabase } from "../../lib/supabase";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
// Sibling topic files are imported directly, as in every module; outside the
// module, uploads.service.ts is the only door.
import { validateDestinationAccess } from "./uploads.access";
import {
  parseUploadSessionRequest,
  UploadSessionValidationError,
  type ParsedUploadSessionRequest,
} from "./uploads.manifest";
import {
  cancelUploadSession,
  completeUploadSessionFile,
  createUploadSession,
  getUploadSession,
  putAuthenticatedUploadPart,
  refreshUploadUrls,
} from "./uploads.sessions";
import { UPLOAD_PART_BYTES } from "./uploads.manifest";
import type { UploadFailure } from "./uploads.shared";

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
  max: 1024,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (_req, res) => String(res.locals.userId),
});

const sessionIdSchema = z.string().uuid();
const partIndexSchema = z.coerce.number().int().min(0).max(12);
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

uploadSessionsRouter.put(
  "/:sessionId/files/:fileId/parts/:partIndex",
  requireAuth,
  uploadPartLimiter,
  asyncRoute(async (req, res) => {
    const partIndex = partIndexSchema.safeParse(req.params.partIndex);
    const generation = sessionIdSchema.safeParse(req.header("X-Upload-Generation"));
    const contentLength = Number(req.header("Content-Length"));
    if (!partIndex.success || !generation.success || !Number.isSafeInteger(contentLength)
      || contentLength < 1 || contentLength > UPLOAD_PART_BYTES
      || req.header("Content-Type") !== "application/octet-stream")
      return void res.status(400).json({ detail: "Invalid upload part" });
    const result = await putAuthenticatedUploadPart(createServerSupabase(), {
      sessionId: req.params.sessionId,
      fileId: req.params.fileId,
      userId: res.locals.userId as string,
      generation: generation.data,
      partIndex: partIndex.data,
      contentLength,
      body: req,
    });
    if (!result.ok) return void sendUploadFailure(res, result);
    res.json(result.data);
  }),
);


/** The one place a service failure becomes a response. */
function sendUploadFailure(res: Response, failure: UploadFailure): void {
  if (failure.kind === "internal") {
    sendInternalError(res, failure.error, failure.status);
    return;
  }
  res.status(failure.status).json(failure.body);
}

// POST /upload-sessions
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
    const access = await validateDestinationAccess(
      manifest,
      userId,
      userEmail,
      db,
    );
    if (!access.ok) return void sendUploadFailure(res, access);

    const created = await createUploadSession(db, {
      sessionId,
      userId,
      userEmail,
      manifest,
      hourlySessionLimit: uploadRateLimits.sessionCreationMaxPerHour,
    });
    if (!created.ok) return void sendUploadFailure(res, created);
    res.status(201).json(created.data);
  }),
);

// GET /upload-sessions/:sessionId
uploadSessionsRouter.get(
  "/:sessionId",
  requireAuth,
  uploadSessionPollingLimiter,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await getUploadSession(db, req.params.sessionId, userId);
    if (!result.ok) return void sendUploadFailure(res, result);
    res.json(result.data);
  }),
);

// POST /upload-sessions/:sessionId/urls
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
    const result = await refreshUploadUrls(db, req.params.sessionId, userId);
    if (!result.ok) return void sendUploadFailure(res, result);
    res.json(result.data);
  }),
);

// POST /upload-sessions/:sessionId/files/:fileId/complete
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
    const result = await completeUploadSessionFile(db, {
      sessionId: req.params.sessionId,
      fileId: req.params.fileId,
      userId,
      failed: parsed.data.failed,
    });
    if (!result.ok) return void sendUploadFailure(res, result);
    res.status(result.data.status).json(result.data.body);
  }),
);

// DELETE /upload-sessions/:sessionId
uploadSessionsRouter.delete(
  "/:sessionId",
  requireAuth,
  uploadSessionMutationLimiter,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await cancelUploadSession(db, req.params.sessionId, userId);
    if (!result.ok) return void sendUploadFailure(res, result);
    res.status(204).end();
  }),
);

uploadSessionsRouter.use(routerErrorHandler("[upload-sessions]"));
