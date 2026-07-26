import { createHash, randomUUID } from "node:crypto";
import type { DocIndex } from "../../../lib/chat/types";
import {
  downloadFile,
  uploadFile,
  versionStorageKey,
} from "../../../lib/storage";
import { createServerSupabase } from "../../../lib/supabase";
import {
  extractDocxForVerification,
  extractPdfForVerification,
  type ExtractionWarning,
} from "./extraction";

type Db = ReturnType<typeof createServerSupabase>;

type DocumentRow = {
  id: string;
  project_id: string | null;
  current_version_id: string | null;
  status: string;
};

type VersionRow = {
  id: string;
  document_id: string;
  storage_path: string | null;
  filename: string | null;
  file_type: string | null;
};

export type ExtractDocumentResult = {
  source_document_id: string;
  source_version_id: string;
  extracted_document_id: string;
  extracted_version_id: string;
  filename: string;
  media_type: "text/markdown";
  source_media_type: "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  page_count: number | null;
  sha256: string;
  source_sha256: string;
  bytes: number;
  warnings: ExtractionWarning[];
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function resolveDocumentId(rawId: string, docIndex: DocIndex): string {
  const direct = docIndex[rawId]?.document_id;
  if (direct) return direct;
  const match = Object.values(docIndex).find(
    (candidate) => candidate.document_id === rawId,
  );
  if (match) return match.document_id;
  throw new Error(`Document is not available in this project: ${rawId}`);
}

function extractedFilename(filename: string | null): string {
  const original = filename?.trim() || "document";
  const withoutExtension = original.replace(/\.[^.]+$/u, "");
  const safe =
    withoutExtension
      .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 160) || "document";
  return `${safe}.verification.md`;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export async function extractDocumentForVerification(
  input: {
    projectId: string;
    userId: string;
    documentId: string;
    versionId?: string;
    firstPage?: number;
    docIndex: DocIndex;
  },
  db: Db = createServerSupabase(),
): Promise<ExtractDocumentResult> {
  if (!input.projectId) {
    throw new Error("Document extraction requires an active project");
  }
  const documentId = resolveDocumentId(input.documentId, input.docIndex);
  const { data: documentData, error: documentError } = await db
    .from("documents")
    .select("id, project_id, current_version_id, status")
    .eq("id", documentId)
    .single();
  if (documentError) throw new Error(documentError.message);
  const document = documentData as DocumentRow | null;
  if (
    !document ||
    document.project_id !== input.projectId ||
    document.status !== "ready"
  ) {
    throw new Error(`Document is not accessible in this project: ${documentId}`);
  }
  const versionId = input.versionId ?? document.current_version_id;
  if (!versionId) {
    throw new Error(`Document has no active version: ${documentId}`);
  }
  const { data: versionData, error: versionError } = await db
    .from("document_versions")
    .select("id, document_id, storage_path, filename, file_type")
    .eq("id", versionId)
    .is("deleted_at", null)
    .single();
  if (versionError) throw new Error(versionError.message);
  const version = versionData as VersionRow | null;
  if (!version || version.document_id !== documentId) {
    throw new Error(
      `Document version is not accessible in this project: ${documentId}/${versionId}`,
    );
  }
  if (!version.storage_path) {
    throw new Error(`Document version has no readable storage path: ${versionId}`);
  }
  const raw = await downloadFile(version.storage_path);
  if (!raw) {
    throw new Error(`Document version could not be read from storage: ${versionId}`);
  }
  const sourceBytes = new Uint8Array(raw);
  const fileType = version.file_type?.trim().toLowerCase();
  const extraction =
    fileType === "docx"
      ? await extractDocxForVerification(sourceBytes)
      : fileType === "pdf"
        ? await extractPdfForVerification(sourceBytes, input.firstPage ?? 1)
        : null;
  if (!extraction) {
    throw new Error(
      `Only DOCX and text-layer PDF documents can be extracted for verification; received ${fileType || "unknown"}`,
    );
  }

  const markdownBytes = new TextEncoder().encode(extraction.markdown);
  const extractedDocumentId = randomUUID();
  const extractedVersionId = randomUUID();
  const filename = extractedFilename(version.filename);
  const storagePath = versionStorageKey(
    input.userId,
    extractedDocumentId,
    extractedVersionId,
    filename,
  );

  // This intentionally occurs before any metadata writes. uploadFile uses the
  // required provider path, so unconfigured storage fails visibly and cannot
  // leave a document row pointing to a blob that was never written.
  await uploadFile(
    storagePath,
    exactArrayBuffer(markdownBytes),
    "text/markdown; charset=utf-8",
  );

  const { error: extractedDocumentError } = await db.from("documents").insert({
    id: extractedDocumentId,
    project_id: input.projectId,
    user_id: input.userId,
    status: "ready",
  });
  if (extractedDocumentError) {
    throw new Error(extractedDocumentError.message);
  }
  const { error: extractedVersionError } = await db
    .from("document_versions")
    .insert({
      id: extractedVersionId,
      document_id: extractedDocumentId,
      storage_path: storagePath,
      pdf_storage_path: null,
      source: "generated",
      version_number: 1,
      filename,
      file_type: "md",
      size_bytes: markdownBytes.byteLength,
      page_count: extraction.pageCount,
    });
  if (extractedVersionError) throw new Error(extractedVersionError.message);
  const { error: currentVersionError } = await db
    .from("documents")
    .update({ current_version_id: extractedVersionId })
    .eq("id", extractedDocumentId);
  if (currentVersionError) throw new Error(currentVersionError.message);

  const sourceHash = sha256(sourceBytes);
  const extractedHash = sha256(markdownBytes);
  const { error: provenanceError } = await db
    .from("citation_verification_extractions")
    .insert({
      project_id: input.projectId,
      user_id: input.userId,
      source_document_id: documentId,
      source_version_id: versionId,
      extracted_document_id: extractedDocumentId,
      extracted_version_id: extractedVersionId,
      options: {
        ...(fileType === "pdf"
          ? { first_page: input.firstPage ?? 1 }
          : {}),
      },
      warnings: extraction.warnings,
      source_sha256: sourceHash,
      extracted_sha256: extractedHash,
    });
  if (provenanceError) throw new Error(provenanceError.message);

  return {
    source_document_id: documentId,
    source_version_id: versionId,
    extracted_document_id: extractedDocumentId,
    extracted_version_id: extractedVersionId,
    filename,
    media_type: "text/markdown",
    source_media_type: extraction.mediaType,
    page_count: extraction.pageCount,
    sha256: extractedHash,
    source_sha256: sourceHash,
    bytes: markdownBytes.byteLength,
    warnings: extraction.warnings,
  };
}
