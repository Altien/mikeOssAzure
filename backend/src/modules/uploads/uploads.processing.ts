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
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

import { AppError } from "../../lib/appError";
import { recordAudit } from "../../lib/audit";
import { runIsolated } from "../../lib/dbq/jobScope";
import { convertedPdfKey, officeFileToPdf } from "../../lib/convert";
import {
  markStage,
  reportError,
  setOperation,
} from "../../lib/observability/sentry";
import {
  createPollFailureGate,
  type PollFailureGate,
} from "../../lib/observability/pollFailureGate";
import { asReportableError } from "../../lib/httpError";
import {
  contentTypeForDocumentType,
  contentTypeForTextDocumentType,
  EMAIL_UPLOAD_CONTENT_TYPE,
  isTextDocumentType,
  shouldConvertToPdf,
} from "../../lib/documentTypes";
import {
  emailDocumentFilename,
  emailToMarkdown,
  newEmailImportBudget,
  type EmailAttachmentDocument,
  type EmailImportBudget,
} from "../../lib/email";
import { countPagesWithoutText } from "../../lib/pdfText";
import { uploadJobWallClockMs } from "../../lib/runtimeConfig";
import {
  copyFile,
  createFileReadStream,
  StorageOperationError,
  uploadFileFromPath,
  versionStorageKey,
  workflowReferenceKey,
} from "../../lib/storage";
import { createPlatformSupabase, createServerSupabase, type Db } from "../../lib/supabase";
import { runWithJobTenant } from "../../lib/tenantContext";
import { withLogContext } from "../../lib/logging/contextLight";
import { log } from "../../lib/logging/root";
import { createDocumentVersion, updateDocumentVersion } from "../documents/documents.service";
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
/** Ceiling for the idle poll interval while every iteration keeps failing. */
const UPLOAD_WORKER_MAX_BACKOFF_MS = 30_000;
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
class ChangedDocumentError extends AppError {
  constructor() {
    super("upload.document_changed", "document_changed");
  }
}

class InvalidPdfFileError extends Error {
  constructor() {
    super("invalid_pdf_file");
    this.name = "InvalidPdfFileError";
  }
}

async function validatePdfHeader(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  try {
    // Require the signature within the first KiB; \s also accepts a UTF-8 BOM.
    // This is a bounded signature check, not a parser.
    const prefix = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    if (!/^\s*%PDF-/.test(prefix.toString("utf8", 0, bytesRead))) {
      throw new InvalidPdfFileError();
    }
  } finally {
    await handle.close();
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

// Measured once at upload so the document list can flag scanned PDFs without
// re-reading them. Null when the PDF cannot be parsed.
async function countTextlessPdfPages(filePath: string): Promise<number | null> {
  try {
    const bytes = await readFile(filePath);
    return await countPagesWithoutText(
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    );
  } catch {
    return null;
  }
}

// Dev divergence (upstream cf5fa985): upstream writes the PDF page metrics in
// processCreatedDocument/processNewDocumentVersion/processReplacementDocumentVersion.
// Dev's worker only prepares claim-specific objects and a payload; the claim-
// fenced finish_upload_processing_job RPC publishes them (0098, 0104).
async function pdfPageMetrics(
  fileType: string,
  filePath: string,
): Promise<{ page_count: number | null; textless_page_count: number | null }> {
  if (fileType !== "pdf") return { page_count: null, textless_page_count: null };
  return {
    page_count: await countPdfPages(filePath),
    textless_page_count: await countTextlessPdfPages(filePath),
  };
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
    markStage("conversion");
    const pdfPath = await officeFileToPdf(
      args.sourceFilePath,
      args.workingDirectory,
    );
    const key = convertedPdfKey(
      args.userId,
      args.documentId,
      args.versionSlug,
    );
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
      throw new AppError("upload.sealed_missing", "sealed_upload_not_found", {
        cause: error,
      });
    }
    throw error;
  }
}

// Prepare immutable, claim-specific storage objects before publishing any
// document/reference row. A reclaimed worker may finish its copy or PDF work,
// but only the current claim can publish these paths in one database RPC.
/** Bytes stored as a document's source, with their storage content type. */
function storedContentType(fileType: string): string {
  return isTextDocumentType(fileType)
    ? contentTypeForTextDocumentType(fileType)
    : contentTypeForDocumentType(fileType);
}

type PreparedUpload = {
  payload: Record<string, unknown>;
  /** Work that needs the published document row; runs once publishing succeeded. */
  afterPublish?: (result: unknown) => Promise<void>;
};

type EmailUpload = {
  /** The Markdown the email became, on local disk. */
  filePath: string;
  size: number;
  sha256: string;
  attachments: EmailAttachmentDocument[];
  budget: EmailImportBudget;
};

async function convertUploadedEmail(file: UploadFileRow, artifact: SealedFileArtifact): Promise<EmailUpload> {
  markStage("conversion");
  // The manifest named the document "<email>.md"; attachments are named after the email.
  const emailFilename = file.filename.replace(/\.md$/i, "");
  const budget = newEmailImportBudget();
  const email = await emailToMarkdown(await readFile(artifact.filePath),
    { emailFilename, budget });
  const bytes = Buffer.from(email.markdown, "utf8");
  const filePath = join(artifact.directory, "email.md");
  await writeFile(filePath, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { filePath, size: bytes.byteLength, sha256, attachments: email.attachments, budget };
}

/** Where a published document sits, copied onto the documents made from its email. */
type DocumentPlacement = Record<
  "user_id" | "project_id" | "folder_id" | "library_kind" | "library_folder_id" | "workflow_id" | "org_id",
  unknown
>;

type EmailImport = {
  db: Db;
  session: UploadSessionRow;
  placement: DocumentPlacement;
  budget: EmailImportBudget;
};

/**
 * Import email attachments as documents of their own beside the email. A
 * nested email becomes Markdown and its own attachments follow, one level
 * deeper, within the same budget. One unreadable attachment does not stop
 * the others.
 */
async function importEmailAttachments(
  context: EmailImport,
  attachments: EmailAttachmentDocument[],
  depth: number,
): Promise<void> {
  for (const attachment of attachments) {
    try {
      if (attachment.fileType !== "eml") {
        await storeEmailAttachment(context, attachment);
        continue;
      }
      const email = await emailToMarkdown(attachment.content,
        { emailFilename: attachment.filename, budget: context.budget, depth });
      await storeEmailAttachment(context, {
        filename: emailDocumentFilename(attachment.filename),
        fileType: "md",
        content: Buffer.from(email.markdown, "utf8"),
      });
      await importEmailAttachments(context, email.attachments, depth + 1);
    } catch (error) {
      reportError(error, {
        level: "warning",
        tags: { component: "upload-worker", stage: "email-attachment", file_type: attachment.fileType },
        fingerprint: ["upload-email-attachment-failed", attachment.fileType],
      });
      console.error("[upload-worker] email attachment import failed", {
        sessionId: context.session.id, fileType: attachment.fileType, error,
      });
    }
  }
}

/** One attachment stored with the conversion and page metrics an upload of it would get. */
async function storeEmailAttachment(
  { db, session, placement }: EmailImport,
  attachment: EmailAttachmentDocument,
): Promise<void> {
  const userId = placement.user_id as string;
  const documentId = randomUUID();
  const versionId = randomUUID();
  const slug = versionId.replace(/-/g, "");
  const directory = await mkdtemp(join(uploadProcessingTempRoot(), "mike-upload-"));
  try {
    const filePath = join(directory, `source.${attachment.fileType}`);
    await writeFile(filePath, attachment.content);
    const sourcePath = versionStorageKey(userId, documentId, slug, attachment.filename);
    await uploadFileFromPath(sourcePath, filePath, storedContentType(attachment.fileType));
    const pdfPath = await buildPdfRendition({ sourceFilePath: filePath, workingDirectory: directory,
      fileType: attachment.fileType, userId, documentId, versionSlug: slug, sourceStoragePath: sourcePath });
    const metrics = await pdfPageMetrics(attachment.fileType, filePath);
    const sha256 = createHash("sha256").update(attachment.content).digest("hex");
    const { error: documentError } = await db.from("documents")
      .insert({ ...placement, id: documentId, status: "ready" });
    if (documentError) throw documentError;
    const { error: versionError } = await createDocumentVersion(db, {
      id: versionId, document_id: documentId, storage_path: sourcePath, pdf_storage_path: pdfPath,
      source: "upload", filename: attachment.filename, file_type: attachment.fileType,
      size_bytes: attachment.content.byteLength, ...metrics, content_sha256: sha256,
    });
    if (versionError) {
      await db.from("documents").delete().eq("id", documentId);
      throw versionError;
    }
    await recordAudit(db, {
      userId: session.user_id, userEmail: session.user_email,
      action: "document.uploaded", title: attachment.filename,
      surface: session.destination.scope === "project" ? "project" : "assistant",
      projectId: (placement.project_id as string | null) ?? null,
      documentId,
    });
  } finally {
    await removeTemporaryArtifact(directory);
  }
}

/**
 * Finish an uploaded email once its Markdown document is published: give the
 * version its real type and size (the manifest could only record a stand-in),
 * then import each attachment as a document in the same place.
 */
async function publishEmailParts(
  db: Db,
  session: UploadSessionRow,
  file: UploadFileRow,
  email: EmailUpload,
  result: unknown,
): Promise<void> {
  const documentId = file.resource_id;
  const { error: versionError } = await updateDocumentVersion(db, documentId, file.id,
    { file_type: "md", size_bytes: email.size });
  if (versionError) throw versionError;
  const published = (result ?? {}) as Record<string, unknown>;
  const { error: resultError } = await db.from("upload_session_files")
    .update({ result: { ...published, file_type: "md", size_bytes: email.size } })
    .eq("id", file.id);
  if (resultError) throw resultError;

  const { data: placement, error: placementError } = await db.from("documents")
    .select("user_id, project_id, folder_id, library_kind, library_folder_id, workflow_id, org_id")
    .eq("id", documentId).single();
  if (placementError || !placement) throw placementError ?? new Error("document_not_found");
  const context = { db, session, placement: placement as DocumentPlacement, budget: email.budget };
  await importEmailAttachments(context, email.attachments, 1);
}

async function prepareUploadFile(
  db: Db,
  session: UploadSessionRow,
  file: UploadFileRow,
  claimToken: string,
): Promise<PreparedUpload> {
  const artifact = await requireSealedFile(file);
  const slug = claimToken.replace(/-/g, "");
  try {
    if (file.file_type === "pdf") await validatePdfHeader(artifact.filePath);
    // An email is stored as the Markdown it converts to. size_bytes stays that
    // of the sealed upload, which the publish RPC checks against the manifest;
    // publishEmailParts corrects it once the row exists.
    const email = file.content_type === EMAIL_UPLOAD_CONTENT_TYPE
      ? await convertUploadedEmail(file, artifact) : null;
    if (email && session.purpose !== "document_create") throw new Error("email_upload_purpose");
    if (session.purpose === "document_create") {
      const scope = session.destination.scope as "standalone" | "project" | "library";
      const documentId = file.resource_id;
      const sourceFilePath = email?.filePath ?? artifact.filePath;
      const fileType = email ? "md" : file.file_type;
      const sourcePath = versionStorageKey(session.user_id, documentId, slug, file.filename);
      if (email) await uploadFileFromPath(sourcePath, email.filePath, storedContentType("md"));
      else await copyFile(file.sealed_storage_path, sourcePath);
      const pdfPath = await buildPdfRendition({ sourceFilePath,
        workingDirectory: artifact.directory, fileType,
        userId: session.user_id, documentId, versionSlug: slug, sourceStoragePath: sourcePath });
      const payload = { kind: session.purpose, source_path: sourcePath, pdf_path: pdfPath,
        size_bytes: artifact.size, sha256: email?.sha256 ?? artifact.sha256,
        ...(await pdfPageMetrics(fileType, sourceFilePath)),
        project_id: scope === "project" ? session.destination.project_id : null,
        folder_id: scope === "project" ? (file.target_folder_id ?? session.destination.folder_id ?? null) : null,
        library_kind: scope === "library" ? session.destination.library_kind : "file",
        library_folder_id: scope === "library" ? (file.target_folder_id ?? session.destination.folder_id ?? null) : null,
      };
      const afterPublish = email
        ? (result: unknown) => publishEmailParts(db, session, file, email, result) : undefined;
      return { payload, afterPublish };
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
      return { payload: { kind: session.purpose, ...baseline, source_path: sourcePath, pdf_path: pdfPath,
        size_bytes: artifact.size, sha256: artifact.sha256,
        ...(await pdfPageMetrics(file.file_type, artifact.filePath)),
        filename: session.purpose === "document_version_create"
          ? ((session.destination.filename as string | undefined)?.trim() || file.filename) : file.filename } };
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
    return { payload: { kind: session.purpose, source_path: sourcePath,
      size_bytes: artifact.size, sha256: artifact.sha256, owner_id: ownerId } };
  } finally {
    await removeTemporaryArtifact(artifact.directory);
  }
}

/**
 * The job row no longer says this worker holds it: another worker claimed
 * it after the lease aged out, or a sweep retired it. Named, so Sentry files
 * it under its own kind (MIKE-BACKEND-M grouped every code-less iteration
 * failure as one anonymous "Failure in upload-worker / iteration").
 */
function leaseLost(): AppError {
  return new AppError("upload.lease_lost", "upload_job_lease_lost");
}

export async function processUploadJob(
  db: Db,
  jobId: string,
  workerId: string,
): Promise<void> {
  setOperation("documents.upload.complete");
  markStage("claim");
  // maybeSingle(): zero rows is a missing row, named below, not a PostgREST
  // PGRST116 error. Database failures still arrive on the error path.
  const { data: job, error: jobError } = await db.from("upload_processing_jobs")
    .select("id, session_id, file_id, attempts, locked_by, claim_token")
    .eq("id", jobId).eq("status", "running").eq("locked_by", workerId).maybeSingle();
  if (jobError || !job || !job.claim_token)
    throw jobError ?? new AppError("upload.job_missing", "upload_job_not_found");
  const typedJob = job as UploadJobRow;
  const { data: session, error: sessionError } = await db.from("upload_sessions")
    .select("id, user_id, user_email, purpose, destination, status")
    .eq("id", typedJob.session_id).maybeSingle();
  if (sessionError || !session) {
    throw sessionError
      ?? new AppError("upload.session_missing", "upload_session_not_found");
  }
  const typedSession = session as UploadSessionRow;
  const { data: file, error: fileError } = await db.from("upload_session_files")
    .select("*").eq("id", typedJob.file_id).eq("session_id", typedSession.id).maybeSingle();
  if (fileError || !file) {
    throw fileError
      ?? new AppError("upload.file_missing", "upload_session_file_not_found");
  }
  const typedFile = file as UploadFileRow;
  const renew = async () => {
    const { data, error } = await db.rpc("renew_upload_processing_job", {
      p_job_id: jobId, p_worker_id: workerId, p_attempt: typedJob.attempts,
      p_token: typedJob.claim_token, p_lease_seconds: UPLOAD_JOB_LEASE_SECONDS,
    });
    if (error || data !== true) throw error ?? leaseLost();
  };
  const finish = async (payload: Record<string, unknown> | null, failure: string | null) => {
    const { data, error } = await db.rpc("finish_upload_processing_job", {
      p_job_id: jobId, p_worker_id: workerId, p_attempt: typedJob.attempts,
      p_token: typedJob.claim_token, p_payload: payload, p_failure: failure,
      p_lease_seconds: UPLOAD_JOB_LEASE_SECONDS,
    });
    if (error || !data) throw error ?? leaseLost();
    return data as { status: string; result?: unknown };
  };
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    if (Date.now() - startedAt >= uploadJobWallClockMs()) return;
    void renew().catch((error) => console.error("[upload-worker] heartbeat failed", { jobId, error }));
  }, UPLOAD_WORKER_HEARTBEAT_MS);
  heartbeat.unref();
  const uploadEvent = (outcome: string) => log().debug("upload.job", {
    uploadJobId: jobId, attempts: typedJob.attempts, sessionId: typedSession.id,
    purpose: typedSession.purpose, format: typedFile.file_type, outcome,
    durationMs: Date.now() - startedAt,
  });
  try {
    await renew();
    uploadEvent("start");
    let prepared: PreparedUpload;
    try {
      markStage("process-file");
      prepared = await prepareUploadFile(db, typedSession, typedFile, typedJob.claim_token);
    } catch (error) {
      // A stale editor save cannot succeed on retry (sync 6e3ef6fa).
      if (error instanceof ChangedDocumentError) {
        uploadEvent("document_changed");
        await finish(null, "document_changed");
        return;
      }
      // Upstream ceedace6: a file that is not a PDF cannot succeed on retry.
      // Dev records it terminally through the publish RPC (migration 0243)
      // instead of upstream's direct job/file updates, and does not report it.
      if (error instanceof InvalidPdfFileError) {
        uploadEvent("invalid_pdf_file");
        await finish(null, "invalid_pdf_file");
        return;
      }
      console.error("[upload-worker] file processing failed", {
        jobId, sessionId: typedSession.id, fileId: typedFile.id,
        purpose: typedSession.purpose, error,
      });
      uploadEvent("processing_failed");
      await finish(null, "processing_failed");
      return;
    }
    if (Date.now() - startedAt >= uploadJobWallClockMs()) {
      uploadEvent("wall_clock_exceeded");
      throw new Error("upload_job_wall_clock_exceeded");
    }
    await renew();
    const published = await finish(prepared.payload, null);
    uploadEvent(published.status === "completed" ? "published" : "publish_refused");
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
    if (prepared.afterPublish) {
      // The job is complete and its lease released; nothing left to renew.
      clearInterval(heartbeat);
      markStage("after-publish");
      await prepared.afterPublish(published.result).catch((error: unknown) => {
        reportError(error, {
          level: "warning",
          tags: { component: "upload-worker", stage: "after-publish" },
          fingerprint: ["upload-after-publish-failed"],
        });
        console.error("[upload-worker] post-publish work failed", {
          jobId, sessionId: typedSession.id, fileId: typedFile.id, error,
        });
      });
    }
  } finally {
    clearInterval(heartbeat);
  }
}

export async function cleanupUploadSessions(db: Db, tenantDb: Db = db): Promise<void> {
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
    .select("id, tenant_id")
    .in("status", ["expired", "cancelled", "error"])
    .is("cleaned_at", null)
    .limit(20);
  if (sessionsError) throw sessionsError;
  for (const session of sessions ?? []) {
    markStage("session-expiry");
    // The RPC queues both immediate and post-signature-expiry prefix sweeps in
    // the same transaction as cleaned_at. Files already processing are left
    // alone; their atomic publish queues their own object cleanup.
    // It is a tenant function: under forced RLS it sees only the claim's
    // tenant, so it runs as the session's tenant (multi-tenant 008).
    await runWithJobTenant(session.tenant_id, async () => {
      const { error } = await tenantDb.rpc("queue_upload_session_cleanup", { p_session_id: session.id });
      if (error) throw error;
    });
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
  // A PostgREST error is a plain object: give it a stack here and keep its
  // `code` (PGRST202 = RPC missing, i.e. migrations not applied) on the
  // cause chain, where the Sentry boundary reads it into failure_code.
  if (error) throw asReportableError(error, claimNextUploadJob);
  return typeof data === "string" && data ? data : null;
}

/** The tenant that queued a claimed upload job (migration 0179), if recorded. */
async function uploadJobTenant(db: Db, jobId: string): Promise<string | null> {
  const { data, error } = await db.from("upload_processing_jobs")
    .select("tenant_id").eq("id", jobId).maybeSingle();
  if (error) throw asReportableError(error, uploadJobTenant);
  return (data as { tenant_id?: string | null } | null)?.tenant_id ?? null;
}

function startUploadProcessingWorker(options: {
  maxRunningPerUser: number;
  runCleanup: boolean;
  failures: PollFailureGate;
}) {
  const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let lastCleanupAt = 0;
  const failures = options.failures;

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), delay);
    timer.unref();
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const db = createServerSupabase();
      // Cleanup and claiming span tenants; the claimed job then runs as the
      // tenant that queued it (multi-tenant issue 003).
      const platformDb = createPlatformSupabase();
      if (options.runCleanup && Date.now() - lastCleanupAt >= 60_000) {
        // Own scope: the stages cleanup marks must not land on a later job.
        await Promise.all([
          runIsolated(() => cleanupUploadSessions(platformDb, db)),
          cleanupUploadProcessingTempFiles(),
        ]);
        lastCleanupAt = Date.now();
      }
      const jobId = await claimNextUploadJob(
        platformDb,
        workerId,
        options.maxRunningPerUser,
      );
      if (!jobId) {
        failures.success();
        schedule(UPLOAD_WORKER_POLL_MS);
        return;
      }
      // Each job in its own Sentry isolation scope: several of these loops
      // share the process, and the operation/stages one job records must not
      // land on another's failure. Inside it, the job runs as the tenant that
      // queued it (multi-tenant issue 003).
      const tenantId = await uploadJobTenant(platformDb, jobId);
      await runIsolated(() =>
        runWithJobTenant(tenantId, () =>
          withLogContext({ jobId }, () => processUploadJob(db, jobId, workerId))),
      );
      failures.success();
      schedule(0);
    } catch (thrown) {
      // Nothing above this loop: an error here means claiming or the job
      // wrapper itself broke, and without a report the worker just polls on.
      const error = asReportableError(thrown);
      const verdict = failures.failure(error);
      if (verdict.report) {
        reportError(error, {
          tags: { component: "upload-worker", stage: "iteration" },
          extra: { worker_id: workerId },
        });
        // The Error object itself, not its message: the console bridge
        // recognises an already-reported object and files no duplicate.
        console.error("[upload-worker] iteration failed", { workerId, error });
      }
      schedule(verdict.delayMs);
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
  // One report per failure class per PROCESS, quiet repeats, backed-off
  // polling. Every loop hits the same database, so one broken RPC fails all
  // of them on every tick; a gate per loop would still file `concurrency`
  // reports, and none at all meant one per tick for hours (MIKE-BACKEND-K:
  // 2,451 events from one worker thread).
  const failures = createPollFailureGate({
    label: "[upload-worker] iteration",
    baseDelayMs: UPLOAD_WORKER_POLL_MS,
    maxDelayMs: UPLOAD_WORKER_MAX_BACKOFF_MS,
  });
  const stopWorkers = Array.from({ length: concurrency }, (_, index) =>
    startUploadProcessingWorker({
      maxRunningPerUser,
      runCleanup: index === 0,
      failures,
    }),
  );

  return () => {
    for (const stopWorker of stopWorkers) stopWorker();
  };
}
