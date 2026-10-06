// Background processing for sealed upload-session files.
//
// The upload protocol has two halves: the HTTP control plane in
// uploads.routes.ts / uploads.sessions.ts, which hands the browser signed URLs
// and seals what it uploads, and this file, which turns a sealed object into
// the document, version, or replacement the session asked for. It runs on the
// worker (see workerRuntime.ts, which reaches it through uploads.service.ts),
// not on a request, so everything here is DB + storage orchestration with no
// req/res in sight.

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

import { recordAudit } from "../../lib/audit";
import { convertedPdfKey, officeFileToPdf } from "../../lib/convert";
import { reportError } from "../../lib/observability/sentry";
import { shouldConvertToPdf } from "../../lib/documentTypes";
import { uploadJobWallClockMs } from "../../lib/runtimeConfig";
import {
  copyFile,
  createFileReadStream,
  deleteFile,
  deleteFileBestEffort,
  StorageOperationError,
  uploadFileFromPath,
  versionStorageKey,
  workflowReferenceKey,
} from "../../lib/storage";
import { createServerSupabase, type Db } from "../../lib/supabase";
import { UPLOAD_VERIFICATION_LEASE_SECONDS } from "./uploads.manifest";

type UploadSessionRow = {
  id: string;
  user_id: string;
  user_email: string | null;
  purpose:
    | "document_create"
    | "document_version_create"
    | "document_version_replace"
    | "workflow_reference_create"
    | "workflow_reference_replace";
  destination: Record<string, unknown>;
  status: string;
};

type UploadFileRow = {
  id: string;
  session_id: string;
  resource_id: string;
  client_id: string;
  filename: string;
  file_type: string;
  content_type: string;
  expected_size_bytes: number;
  sealed_storage_path: string;
  target_folder_id: string | null;
  status: string;
  error_code: string | null;
  /**
   * When the worker wrote the destination documents row for this file. Null
   * until then, so a retry can tell "never created" from "created, then
   * deleted by the user" — the attempt counter cannot make that distinction.
   */
};

type UploadJobRow = {
  id: string;
  session_id: string;
  file_id: string;
  attempts: number;
  locked_by: string | null;
  claim_token: string;
};

type SealedFileArtifact = {
  directory: string;
  filePath: string;
  size: number;
  sha256: string;
};

export const UPLOAD_JOB_LEASE_SECONDS = 30 * 60;
const UPLOAD_WORKER_POLL_MS = 1_000;
const UPLOAD_WORKER_HEARTBEAT_MS = 60_000;
const UPLOAD_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const UPLOAD_TEMP_RETENTION_MS = 2 * UPLOAD_JOB_LEASE_SECONDS * 1000;

/**
 * The document this upload was destined for was deleted while it processed.
 *
 * Less a failure of the upload than a race the user already resolved: they
 * asked for the document to go, and it went. The only correct outcome is to
 * stop, mark the file failed, and clean up whatever bytes this job wrote —
 * never to recreate the row.
 */
class ChangedDocumentError extends Error {
  constructor() {
    super("document_changed");
    this.name = "ChangedDocumentError";
  }
}

/**
 * Upstream sync 6e3ef6fa (#559): an editor save names the content hash it
 * started from. Refuse before staging anything when the version has already
 * moved on, and hand the observed path/hash to the publish RPC, which repeats
 * the comparison atomically (migration 0098). An unhashed legacy version is
 * hashed from its stored bytes. A version already holding these exact bytes
 * (a concurrent identical save) is not a conflict.
 */
async function observeReplacementBaseline(
  db: Db,
  session: UploadSessionRow,
  artifact: SealedFileArtifact,
): Promise<Record<string, unknown>> {
  const expectedHash = session.destination.expected_content_sha256;
  if (typeof expectedHash !== "string") return {};
  const { data: current, error } = await db
    .from("document_versions")
    .select("storage_path, content_sha256")
    .eq("id", session.destination.version_id as string)
    .eq("document_id", session.destination.document_id as string)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!current) throw new Error("version_not_found");
  const storedHash = (current.content_sha256 as string | null) ?? null;
  let currentHash = storedHash;
  if (!currentHash) {
    const hash = createHash("sha256");
    for await (const chunk of await createFileReadStream(current.storage_path as string))
      hash.update(chunk as Buffer);
    currentHash = hash.digest("hex");
  }
  if (currentHash !== expectedHash && currentHash !== artifact.sha256)
    throw new ChangedDocumentError();
  return {
    expected_storage_path: current.storage_path,
    expected_content_sha256: storedHash,
  };
}

async function countPdfPages(filePath: string): Promise<number | null> {
  let loadingTask:
    | {
        promise: Promise<{ numPages: number }>;
        destroy?: () => Promise<void>;
      }
    | undefined;
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    loadingTask = (
      pdfjsLib as unknown as {
        getDocument: (options: unknown) => {
          promise: Promise<{ numPages: number }>;
          destroy?: () => Promise<void>;
        };
      }
    ).getDocument({ url: pathToFileURL(filePath).href });
    const pdf = await loadingTask.promise;
    return pdf.numPages;
  } catch {
    return null;
  } finally {
    await loadingTask?.destroy?.().catch(() => {});
  }
}

async function buildPdfRendition(args: {
  sourceFilePath: string;
  workingDirectory: string;
  fileType: string;
  userId: string;
  documentId: string;
  versionSlug?: string;
  sourceStoragePath: string;
}): Promise<string | null> {
  if (args.fileType === "pdf") return args.sourceStoragePath;
  if (!shouldConvertToPdf(args.fileType)) return null;
  try {
    const pdfPath = await officeFileToPdf(
      args.sourceFilePath,
      args.workingDirectory,
    );
    const key = args.versionSlug
      ? `converted-pdfs/${args.userId}/${args.documentId}/${args.versionSlug}.pdf`
      : convertedPdfKey(args.userId, args.documentId);
    await uploadFileFromPath(key, pdfPath, "application/pdf");
    return key;
  } catch (error) {
    // Non-fatal for the upload (the original stays usable) but a conversion
    // that fails is either a LibreOffice regression or a malformed file we
    // should know about — grouped by file type so a format-wide break is one
    // issue with a count, not noise.
    reportError(error, {
      level: "warning",
      tags: {
        component: "upload-worker",
        stage: "conversion",
        file_type: args.fileType,
      },
      extra: { document_id: args.documentId },
      fingerprint: ["upload-conversion-failed", args.fileType],
    });
    console.error("[upload-worker] document conversion failed", {
      documentId: args.documentId,
      fileType: args.fileType,
      error,
    });
    return null;
  }
}

async function removeTemporaryArtifact(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true }).catch((error) => {
    console.error("[upload-worker] temporary file cleanup failed", {
      directory,
      error,
    });
  });
}

function uploadProcessingTempRoot(): string {
  return process.env.UPLOAD_PROCESSING_TEMP_DIR?.trim() || tmpdir();
}

export async function cleanupUploadProcessingTempFiles(
  now = Date.now(),
): Promise<void> {
  const root = uploadProcessingTempRoot();
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  await Promise.all(
    entries
      .filter(
        (entry) => entry.isDirectory() && entry.name.startsWith("mike-upload-"),
      )
      .map(async (entry) => {
        const directory = join(root, entry.name);
        const metadata = await stat(directory).catch(() => null);
        if (!metadata || now - metadata.mtimeMs < UPLOAD_TEMP_RETENTION_MS) {
          return;
        }
        await removeTemporaryArtifact(directory);
      }),
  );
}

async function requireSealedFile(
  file: UploadFileRow,
): Promise<SealedFileArtifact> {
  const temporaryRoot = uploadProcessingTempRoot();
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, "mike-upload-"));
  const extension = /^[a-z0-9]{1,16}$/.test(file.file_type)
    ? file.file_type
    : "bin";
  const filePath = join(directory, `source.${extension}`);
  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength;
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      createFileReadStream(file.sealed_storage_path),
      meter,
      createWriteStream(filePath, { flags: "wx" }),
    );
    if (size !== file.expected_size_bytes) {
      throw new Error("sealed_upload_size_mismatch");
    }
    return {
      directory,
      filePath,
      size,
      sha256: hash.digest("hex"),
    };
  } catch (error) {
    await removeTemporaryArtifact(directory);
    if (error instanceof StorageOperationError) {
      throw new Error("sealed_upload_not_found", { cause: error });
    }
    throw error;
  }
}

// Prepare immutable, claim-specific storage objects before publishing any
// document/reference row. A reclaimed worker may finish its copy or PDF work,
// but only the current claim can publish these paths in one database RPC.
async function prepareUploadFile(
  db: Db,
  session: UploadSessionRow,
  file: UploadFileRow,
  claimToken: string,
): Promise<Record<string, unknown>> {
  const artifact = await requireSealedFile(file);
  const slug = claimToken.replace(/-/g, "");
  try {
    if (session.purpose === "document_create") {
      const scope = session.destination.scope as "standalone" | "project" | "library";
      const documentId = file.resource_id;
      const sourcePath = versionStorageKey(session.user_id, documentId, slug, file.filename);
      await copyFile(file.sealed_storage_path, sourcePath);
      const pdfPath = await buildPdfRendition({ sourceFilePath: artifact.filePath,
        workingDirectory: artifact.directory, fileType: file.file_type,
        userId: session.user_id, documentId, versionSlug: slug, sourceStoragePath: sourcePath });
      return { kind: session.purpose, source_path: sourcePath, pdf_path: pdfPath,
        size_bytes: artifact.size, sha256: artifact.sha256,
        page_count: file.file_type === "pdf" ? await countPdfPages(artifact.filePath) : null,
        project_id: scope === "project" ? session.destination.project_id : null,
        folder_id: scope === "project" ? (file.target_folder_id ?? session.destination.folder_id ?? null) : null,
        library_kind: scope === "library" ? session.destination.library_kind : "file",
        library_folder_id: scope === "library" ? (file.target_folder_id ?? session.destination.folder_id ?? null) : null,
      };
    }
    if (session.purpose === "document_version_create" || session.purpose === "document_version_replace") {
      const documentId = session.destination.document_id as string;
      const baseline = session.purpose === "document_version_replace"
        ? await observeReplacementBaseline(db, session, artifact)
        : {};
      const sourcePath = versionStorageKey(session.user_id, documentId, slug, file.filename);
      await copyFile(file.sealed_storage_path, sourcePath);
      // Editor saves persist only the source; the replacement retires the old
      // rendition. An uploaded PDF is already its own rendition.
      const skipPdf = session.purpose === "document_version_replace"
        && session.destination.generate_pdf === false && file.file_type !== "pdf";
      const pdfPath = skipPdf ? null : await buildPdfRendition({ sourceFilePath: artifact.filePath,
        workingDirectory: artifact.directory, fileType: file.file_type,
        userId: session.user_id, documentId, versionSlug: slug, sourceStoragePath: sourcePath });
      return { kind: session.purpose, ...baseline, source_path: sourcePath, pdf_path: pdfPath,
        size_bytes: artifact.size, sha256: artifact.sha256,
        page_count: file.file_type === "pdf" ? await countPdfPages(artifact.filePath) : null,
        filename: session.purpose === "document_version_create"
          ? ((session.destination.filename as string | undefined)?.trim() || file.filename) : file.filename };
    }
    const workflowId = session.destination.workflow_id as string;
    const { data: workflow, error: workflowError } = await db.from("workflows")
      .select("id, user_id").eq("id", workflowId).single();
    if (workflowError || !workflow) throw workflowError ?? new Error("workflow_not_found");
    const ownerId = (workflow.user_id as string | null) ?? session.user_id;
    const referenceId = session.purpose === "workflow_reference_replace"
      ? session.destination.reference_id as string : file.resource_id;
    const sourcePath = workflowReferenceKey(ownerId, workflowId, referenceId,
      `${artifact.sha256}-${slug}`, file.filename);
    await copyFile(file.sealed_storage_path, sourcePath);
    return { kind: session.purpose, source_path: sourcePath,
      size_bytes: artifact.size, sha256: artifact.sha256, owner_id: ownerId };
  } finally {
    await removeTemporaryArtifact(artifact.directory);
  }
}

export async function processUploadJob(
  db: Db,
  jobId: string,
  workerId: string,
): Promise<void> {
  const { data: job, error: jobError } = await db.from("upload_processing_jobs")
    .select("id, session_id, file_id, attempts, locked_by, claim_token")
    .eq("id", jobId).eq("status", "running").eq("locked_by", workerId).single();
  if (jobError || !job || !job.claim_token) throw jobError ?? new Error("upload_job_not_found");
  const typedJob = job as UploadJobRow;
  const { data: session, error: sessionError } = await db.from("upload_sessions")
    .select("id, user_id, user_email, purpose, destination, status")
    .eq("id", typedJob.session_id).single();
  if (sessionError || !session) throw sessionError ?? new Error("upload_session_not_found");
  const typedSession = session as UploadSessionRow;
  const { data: file, error: fileError } = await db.from("upload_session_files")
    .select("*").eq("id", typedJob.file_id).eq("session_id", typedSession.id).single();
  if (fileError || !file) throw fileError ?? new Error("upload_session_file_not_found");
  const typedFile = file as UploadFileRow;
  const renew = async () => {
    const { data, error } = await db.rpc("renew_upload_processing_job", {
      p_job_id: jobId, p_worker_id: workerId, p_attempt: typedJob.attempts,
      p_token: typedJob.claim_token, p_lease_seconds: UPLOAD_JOB_LEASE_SECONDS,
    });
    if (error || data !== true) throw error ?? new Error("upload_job_lease_lost");
  };
  const finish = async (payload: Record<string, unknown> | null, failure: string | null) => {
    const { data, error } = await db.rpc("finish_upload_processing_job", {
      p_job_id: jobId, p_worker_id: workerId, p_attempt: typedJob.attempts,
      p_token: typedJob.claim_token, p_payload: payload, p_failure: failure,
      p_lease_seconds: UPLOAD_JOB_LEASE_SECONDS,
    });
    if (error || !data) throw error ?? new Error("upload_job_lease_lost");
    return data as { status: string; result?: unknown };
  };
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    if (Date.now() - startedAt >= uploadJobWallClockMs()) return;
    void renew().catch((error) => console.error("[upload-worker] heartbeat failed", { jobId, error }));
  }, UPLOAD_WORKER_HEARTBEAT_MS);
  heartbeat.unref();
  try {
    await renew();
    let payload: Record<string, unknown>;
    try {
      payload = await prepareUploadFile(db, typedSession, typedFile, typedJob.claim_token);
    } catch (error) {
      // A stale editor save cannot succeed on retry (sync 6e3ef6fa).
      if (error instanceof ChangedDocumentError) {
        await finish(null, "document_changed");
        return;
      }
      console.error("[upload-worker] file processing failed", {
        jobId, sessionId: typedSession.id, fileId: typedFile.id,
        purpose: typedSession.purpose, error,
      });
      await finish(null, "processing_failed");
      return;
    }
    if (Date.now() - startedAt >= uploadJobWallClockMs()) {
      throw new Error("upload_job_wall_clock_exceeded");
    }
    await renew();
    const published = await finish(payload, null);
    // The publish RPC lost its compare-and-swap and recorded the terminal
    // document_changed outcome itself.
    if (published.status === "error") return;
    if (published.status !== "completed") throw new Error("upload_job_not_published");
    if (typedSession.purpose === "document_create") {
      await recordAudit(db, {
        userId: typedSession.user_id, userEmail: typedSession.user_email,
        action: "document.uploaded", title: typedFile.filename,
        surface: typedSession.destination.scope === "project" ? "project" : "assistant",
        projectId: typedSession.destination.scope === "project"
          ? typedSession.destination.project_id as string : null,
        documentId: typedFile.resource_id,
      });
    }
  } finally {
    clearInterval(heartbeat);
  }
}

export async function cleanupUploadSessions(db: Db): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const { error: expireError } = await db
    .from("upload_sessions")
    .update({
      status: "expired",
      error_code: "session_expired",
      updated_at: nowIso,
    })
    .eq("status", "pending_upload")
    .lt("expires_at", nowIso);
  if (expireError) throw expireError;

  const verificationCutoff = new Date(
    now.getTime() - UPLOAD_VERIFICATION_LEASE_SECONDS * 1000,
  ).toISOString();
  const { error: verificationError } = await db
    .from("upload_sessions")
    .update({
      status: "error",
      error_code: "verification_timeout",
      updated_at: nowIso,
    })
    .eq("status", "verifying")
    .lt("updated_at", verificationCutoff);
  if (verificationError) throw verificationError;

  const { error: exhaustedError } = await db.rpc("expire_exhausted_upload_jobs", {
    p_lease_seconds: UPLOAD_JOB_LEASE_SECONDS, p_limit: 20,
  });
  if (exhaustedError) throw exhaustedError;

  const { data: sessions, error: sessionsError } = await db
    .from("upload_sessions")
    .select("id")
    .in("status", ["expired", "cancelled", "error"])
    .is("cleaned_at", null)
    .limit(20);
  if (sessionsError) throw sessionsError;
  for (const session of sessions ?? []) {
    // The RPC queues both immediate and post-signature-expiry prefix sweeps in
    // the same transaction as cleaned_at. Files already processing are left
    // alone; their atomic publish queues their own object cleanup.
    const { error } = await db.rpc("queue_upload_session_cleanup", { p_session_id: session.id });
    if (error) throw error;
  }

  const retentionCutoff = new Date(
    now.getTime() - UPLOAD_SESSION_RETENTION_MS,
  ).toISOString();
  const { data: retained, error: retentionError } = await db
    .from("upload_sessions")
    .select("id")
    .in("status", ["completed", "expired", "cancelled", "error"])
    .not("cleaned_at", "is", null)
    .lt("updated_at", retentionCutoff)
    .limit(20);
  if (retentionError) throw retentionError;
  const retainedIds = (retained ?? []).map((session) => session.id);
  if (retainedIds.length > 0) {
    const { error } = await db
      .from("upload_sessions")
      .delete()
      .in("id", retainedIds);
    if (error) throw error;
  }
}

async function claimNextUploadJob(
  db: Db,
  workerId: string,
  maxRunningPerUser: number,
) {
  const { data, error } = await db.rpc("claim_upload_processing_job", {
    target_worker_id: workerId,
    target_lease_seconds: UPLOAD_JOB_LEASE_SECONDS,
    target_max_running_per_user: maxRunningPerUser,
  });
  if (error) throw error;
  return typeof data === "string" && data ? data : null;
}

function startUploadProcessingWorker(options: {
  maxRunningPerUser: number;
  runCleanup: boolean;
}) {
  const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let lastCleanupAt = 0;

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), delay);
    timer.unref();
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const db = createServerSupabase();
      if (options.runCleanup && Date.now() - lastCleanupAt >= 60_000) {
        await Promise.all([
          cleanupUploadSessions(db),
          cleanupUploadProcessingTempFiles(),
        ]);
        lastCleanupAt = Date.now();
      }
      const jobId = await claimNextUploadJob(
        db,
        workerId,
        options.maxRunningPerUser,
      );
      if (!jobId) {
        schedule(UPLOAD_WORKER_POLL_MS);
        return;
      }
      await processUploadJob(db, jobId, workerId);
      schedule(0);
    } catch (error) {
      // Nothing above this loop: an error here means claiming or the job
      // wrapper itself broke, and without a report the worker just polls on.
      reportError(error, {
        tags: { component: "upload-worker", stage: "iteration" },
        extra: { worker_id: workerId },
      });
      console.error("[upload-worker] iteration failed", { workerId, error });
      schedule(UPLOAD_WORKER_POLL_MS);
    }
  };

  schedule(0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export function startUploadProcessingWorkers(options: {
  concurrency: number;
  maxRunningPerUser: number;
}) {
  const concurrency = Math.max(1, Math.floor(options.concurrency));
  const maxRunningPerUser = Math.max(
    1,
    Math.min(concurrency, Math.floor(options.maxRunningPerUser)),
  );
  const stopWorkers = Array.from({ length: concurrency }, (_, index) =>
    startUploadProcessingWorker({
      maxRunningPerUser,
      runCleanup: index === 0,
    }),
  );

  return () => {
    for (const stopWorker of stopWorkers) stopWorker();
  };
}
