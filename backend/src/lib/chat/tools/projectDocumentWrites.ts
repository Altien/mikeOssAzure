import { randomUUID } from "node:crypto";
import {
  TEXT_DOCUMENT_TYPES_LABEL,
  contentTypeForTextDocumentType,
  isTextDocumentType,
} from "../../documentTypes";
import { buildDownloadUrl } from "../../downloadTokens";
import { uploadFile, versionStorageKey } from "../../storage";
import { createServerSupabase } from "../../supabase";

type Db = ReturnType<typeof createServerSupabase>;

/**
 * The durable marker for "this document was written by write_project_document"
 * (migration 0035). It is a `document_versions.source` value of its own rather
 * than a reuse of 'generated' precisely so the tool can never add a version to
 * a generated .docx, a user upload, or a skill package file — the source is
 * what the conflict check reads.
 */
export const TOOL_WRITE_SOURCE = "tool_write";

/** UTF-8 bytes, not characters: what is actually stored is what is capped. */
const MAX_CONTENT_BYTES = 1024 * 1024;

/**
 * Binary formats a model reaches for when it wants a document rather than a
 * text file. Naming the generator is the difference between a refusal it can
 * act on and one it retries verbatim.
 */
const GENERATOR_FOR_TYPE: Record<string, string> = {
  docx: "generate_docx",
  doc: "generate_docx",
  pdf: "generate_docx",
  xlsx: "generate_excel",
  xlsm: "generate_excel",
  xls: "generate_excel",
  pptx: "generate_ppt",
  ppt: "generate_ppt",
};

/** What a conflicting document is, in words a model can report to a person. */
const SOURCE_DESCRIPTIONS: Record<string, string> = {
  upload: "a document uploaded to this project",
  user_upload: "a document uploaded to this project",
  assistant_edit: "an edited version of a document in this project",
  user_accept: "an edited version of a document in this project",
  user_reject: "an edited version of a document in this project",
  generated: "a document produced by generate_docx / generate_excel / generate_ppt",
  external_retrieval: "an external source saved into this project",
  skill_import: "a file belonging to an imported skill package",
};

export type WriteProjectDocumentRefusal = {
  ok: false;
  error:
    | "no_active_project"
    | "invalid_filename"
    | "unsupported_file_type"
    | "content_too_large"
    | "filename_conflict";
  detail: string;
  /** Present when another tool is the right way to produce this file. */
  use_instead?: string;
};

export type WriteProjectDocumentResult =
  | {
      ok: true;
      document_id: string;
      version_id: string;
      filename: string;
      bytes: number;
      created: "new" | "version";
      download_url: string;
      version_number: number;
      storage_path: string;
    }
  | WriteProjectDocumentRefusal;

function refuse(
  error: WriteProjectDocumentRefusal["error"],
  detail: string,
  useInstead?: string,
): WriteProjectDocumentRefusal {
  return {
    ok: false,
    error,
    detail,
    ...(useInstead ? { use_instead: useInstead } : {}),
  };
}

/**
 * Filenames are refused rather than sanitised.
 *
 * `safeGeneratedFilename` rewrites a title into something safe, which is right
 * when the model supplied a heading and does not care what the file is called.
 * Here the name is the identity: it decides whether this write is a new
 * version of an earlier one, so silently turning `../cites.json` into
 * `cites.json` would version a document the model never named.
 */
function filenameProblem(filename: string): string | null {
  if (!filename) return "A filename is required.";
  if (filename !== filename.trim()) {
    return "Filenames may not start or end with whitespace.";
  }
  if (filename.length > 200) return "Filenames may be at most 200 characters.";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(filename)) {
    return "Filenames may not contain control characters.";
  }
  if (/[\\/]/.test(filename)) {
    return "Filenames may not contain directory separators — a project document has no path, only a name.";
  }
  if (filename.startsWith(".")) {
    return "Filenames may not start with a dot.";
  }
  if (/[<>:"|?*]/.test(filename)) {
    return 'Filenames may not contain any of < > : " | ? *';
  }
  return null;
}

function extensionOf(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  return lastDot <= 0 ? "" : filename.slice(lastDot + 1).toLowerCase();
}

/**
 * The document in this project currently carrying `filename`, identified by
 * its active version — a document's name is whatever its current version is
 * called, which is also what list_documents shows.
 */
async function findByFilename(
  projectId: string,
  filename: string,
  db: Db,
): Promise<{
  documentId: string;
  versionId: string;
  versionNumber: number | null;
  source: string | null;
} | null> {
  const { data: documents } = await db
    .from("documents")
    .select("id, current_version_id")
    .eq("project_id", projectId);
  const currentVersionIds = ((documents ?? []) as {
    id: string;
    current_version_id: string | null;
  }[])
    .map((row) => row.current_version_id)
    .filter((id): id is string => typeof id === "string" && !!id);
  if (!currentVersionIds.length) return null;

  const { data: versions } = await db
    .from("document_versions")
    .select("id, document_id, filename, source, version_number")
    .in("id", currentVersionIds)
    .is("deleted_at", null);
  const match = ((versions ?? []) as {
    id: string;
    document_id: string;
    filename: string | null;
    source: string | null;
    version_number: number | null;
  }[]).find((row) => (row.filename ?? "").trim() === filename);
  if (!match) return null;
  return {
    documentId: match.document_id,
    versionId: match.id,
    versionNumber: match.version_number,
    source: match.source,
  };
}

/**
 * Write a UTF-8 text document into the chat's active project.
 *
 * Imported skills are written against a scratch filesystem — write cites.json,
 * read it back, write review.html. Mike has no filesystem, so project
 * documents are the honest replacement, and the same filename written twice
 * has to behave like the same file: a second version of one document, not a
 * second document.
 *
 * The upload happens before either metadata write, as extraction and the
 * Authority Trace export do: unconfigured storage then fails visibly instead
 * of leaving a row pointing at a blob that was never written.
 */
export async function writeProjectDocument(
  input: {
    filename: string;
    content: string;
    userId: string;
    projectId?: string | null;
  },
  db: Db = createServerSupabase(),
): Promise<WriteProjectDocumentResult> {
  if (!input.projectId) {
    return refuse(
      "no_active_project",
      "This chat has no active project, and a document can only be written into a project. Tell the user the work needs to happen in a project chat.",
    );
  }

  const filename = typeof input.filename === "string" ? input.filename : "";
  const problem = filenameProblem(filename);
  if (problem) return refuse("invalid_filename", problem);

  const fileType = extensionOf(filename);
  if (!isTextDocumentType(fileType)) {
    const generator = GENERATOR_FOR_TYPE[fileType];
    return refuse(
      "unsupported_file_type",
      generator
        ? `'${filename}' is not a text file. write_project_document writes text only (${TEXT_DOCUMENT_TYPES_LABEL}); use ${generator} to produce a ${fileType || "binary"} document.`
        : `'${filename}' does not end in an allowed text extension. Allowed: ${TEXT_DOCUMENT_TYPES_LABEL}.`,
      generator,
    );
  }

  const content = typeof input.content === "string" ? input.content : "";
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > MAX_CONTENT_BYTES) {
    return refuse(
      "content_too_large",
      `Content is ${bytes.byteLength} bytes of UTF-8; the limit is ${MAX_CONTENT_BYTES} bytes (1 MiB). Write less, or split it across documents.`,
    );
  }

  const existing = await findByFilename(input.projectId, filename, db);
  if (existing && existing.source !== TOOL_WRITE_SOURCE) {
    const description =
      SOURCE_DESCRIPTIONS[existing.source ?? ""] ??
      "a document this tool did not write";
    return refuse(
      "filename_conflict",
      `'${filename}' already exists in this project as ${description}. write_project_document only adds versions to documents it wrote itself; choose a different filename.`,
    );
  }

  const documentId = existing?.documentId ?? randomUUID();
  const versionId = randomUUID();
  const versionNumber = existing ? (existing.versionNumber ?? 1) + 1 : 1;
  const storagePath = versionStorageKey(
    input.userId,
    documentId,
    versionId,
    filename,
  );

  await uploadFile(
    storagePath,
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    contentTypeForTextDocumentType(fileType),
  );

  if (!existing) {
    const { error: documentError } = await db.from("documents").insert({
      id: documentId,
      project_id: input.projectId,
      user_id: input.userId,
      status: "ready",
    });
    if (documentError) throw new Error(documentError.message);
  }

  const { error: versionError } = await db.from("document_versions").insert({
    id: versionId,
    document_id: documentId,
    storage_path: storagePath,
    pdf_storage_path: null,
    source: TOOL_WRITE_SOURCE,
    version_number: versionNumber,
    filename,
    file_type: fileType,
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
    document_id: documentId,
    version_id: versionId,
    filename,
    bytes: bytes.byteLength,
    created: existing ? "version" : "new",
    download_url: buildDownloadUrl(storagePath, filename),
    version_number: versionNumber,
    storage_path: storagePath,
  };
}
