import crypto from "node:crypto";
import { attachActiveVersionPaths } from "./documentVersions";
import { readDocumentContent } from "./chat/tools/documentOps";
import {
  createServerDatabase,
  databaseProviderIsSQLite,
  type ServerDatabase,
} from "./database";
import { getSqliteDb } from "./sqlite";

type Db = ServerDatabase;

export const MAX_LEGAL_MONITOR_DOCUMENTS = 10;
const MAX_DOCUMENT_CHARS = 12_000;
const MAX_CONTEXT_CHARS = 40_000;

type DocumentRow = {
  id: string;
  user_id: string;
  project_id: string | null;
  library_kind: string | null;
  status: string;
  current_version_id: string | null;
  updated_at: string | null;
  filename?: string | null;
  storage_path?: string | null;
  file_type?: string | null;
  size_bytes?: number | null;
  active_version_number?: number | null;
};

type LinkRow = {
  monitor_id: string;
  user_id: string;
  document_id: string;
  position: number | string;
  created_at: string;
};

export type LegalMonitorReferenceDocument = {
  id: string;
  filename: string;
  fileType: string | null;
  sizeBytes: number | null;
  versionNumber: number | null;
  status: string;
  updatedAt: string | null;
};

let schemaReady = false;

export function ensureLegalMonitorDocumentSchema(): void {
  if (!databaseProviderIsSQLite()) return;
  if (schemaReady) return;
  getSqliteDb().exec(`
      create table if not exists legal_monitor_documents (
        id text primary key,
        monitor_id text not null,
        user_id text not null,
        document_id text not null,
        position integer not null default 0,
        created_at text not null,
        unique(monitor_id, document_id)
      );
      create index if not exists idx_legal_monitor_documents_monitor
        on legal_monitor_documents(monitor_id, position);
      create index if not exists idx_legal_monitor_documents_document
        on legal_monitor_documents(document_id);
      create index if not exists idx_legal_monitor_documents_user
        on legal_monitor_documents(user_id);
    `);
  schemaReady = true;
}

function uniqueDocumentIds(documentIds: string[]): string[] {
  return [...new Set(documentIds.map((id) => id.trim()).filter(Boolean))];
}

async function loadLibraryDocuments(
  userId: string,
  documentIds: string[],
  db: Db,
): Promise<DocumentRow[]> {
  if (!documentIds.length) return [];
  const { data, error } = await db
    .from("documents")
    .select(
      "id, user_id, project_id, library_kind, status, current_version_id, updated_at",
    )
    .eq("user_id", userId)
    .is("project_id", null)
    .in("id", documentIds);
  if (error) throw error;
  const documents = ((data ?? []) as DocumentRow[]).filter(
    (document) =>
      document.library_kind == null || document.library_kind === "file",
  );
  await attachActiveVersionPaths(db, documents);
  return documents;
}

function publicDocument(document: DocumentRow): LegalMonitorReferenceDocument {
  const sizeBytes =
    document.size_bytes == null ? null : Number(document.size_bytes);
  const versionNumber =
    document.active_version_number == null
      ? null
      : Number(document.active_version_number);
  return {
    id: document.id,
    filename: document.filename?.trim() || "Untitled document",
    fileType: document.file_type ?? null,
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
    versionNumber: Number.isFinite(versionNumber) ? versionNumber : null,
    status: document.status,
    updatedAt: document.updated_at ?? null,
  };
}

export async function listLegalMonitorDocuments(
  userId: string,
  monitorId: string,
  db: Db = createServerDatabase(),
): Promise<LegalMonitorReferenceDocument[]> {
  ensureLegalMonitorDocumentSchema();
  const { data, error } = await db
    .from("legal_monitor_documents")
    .select("*")
    .eq("user_id", userId)
    .eq("monitor_id", monitorId)
    .order("position", { ascending: true });
  if (error) throw error;
  const links = (data ?? []) as LinkRow[];
  const documents = await loadLibraryDocuments(
    userId,
    links.map((link) => link.document_id),
    db,
  );
  const byId = new Map(documents.map((document) => [document.id, document]));
  return links.flatMap((link) => {
    const document = byId.get(link.document_id);
    return document ? [publicDocument(document)] : [];
  });
}

export async function replaceLegalMonitorDocuments(
  userId: string,
  monitorId: string,
  rawDocumentIds: string[],
  db: Db = createServerDatabase(),
): Promise<LegalMonitorReferenceDocument[]> {
  ensureLegalMonitorDocumentSchema();
  const { documentIds, documents } = await validateLegalMonitorDocuments(
    userId,
    rawDocumentIds,
    db,
  );
  const byId = new Map(documents.map((document) => [document.id, document]));

  const { error: deleteError } = await db
    .from("legal_monitor_documents")
    .delete()
    .eq("user_id", userId)
    .eq("monitor_id", monitorId);
  if (deleteError) throw deleteError;

  if (documentIds.length) {
    const now = new Date().toISOString();
    const { error: insertError } = await db
      .from("legal_monitor_documents")
      .insert(
        documentIds.map((documentId, position) => ({
          id: crypto.randomUUID(),
          monitor_id: monitorId,
          user_id: userId,
          document_id: documentId,
          position,
          created_at: now,
        })),
      );
    if (insertError) throw insertError;
  }

  return documentIds.map((id) => publicDocument(byId.get(id)!));
}

export async function validateLegalMonitorDocuments(
  userId: string,
  rawDocumentIds: string[],
  db: Db = createServerDatabase(),
): Promise<{ documentIds: string[]; documents: DocumentRow[] }> {
  ensureLegalMonitorDocumentSchema();
  const documentIds = uniqueDocumentIds(rawDocumentIds);
  if (documentIds.length > MAX_LEGAL_MONITOR_DOCUMENTS) {
    throw new Error(
      `Select no more than ${MAX_LEGAL_MONITOR_DOCUMENTS} Library files.`,
    );
  }

  const documents = await loadLibraryDocuments(userId, documentIds, db);
  const byId = new Map(documents.map((document) => [document.id, document]));
  if (
    documents.length !== documentIds.length ||
    documentIds.some((id) => !byId.has(id))
  ) {
    throw new Error(
      "One or more selected files are not available in your Library.",
    );
  }
  const unavailable = documents.find(
    (document) =>
      document.status !== "ready" ||
      !document.current_version_id ||
      !document.storage_path,
  );
  if (unavailable) {
    throw new Error(
      `${unavailable.filename || "A selected Library file"} is not ready to use.`,
    );
  }
  return { documentIds, documents };
}

export async function deleteLegalMonitorDocumentLinks(
  userId: string,
  monitorId: string,
  db: Db = createServerDatabase(),
): Promise<void> {
  ensureLegalMonitorDocumentSchema();
  const { error } = await db
    .from("legal_monitor_documents")
    .delete()
    .eq("user_id", userId)
    .eq("monitor_id", monitorId);
  if (error) throw error;
}

export async function loadLegalMonitorDocumentContext(
  userId: string,
  monitorId: string,
  db: Db = createServerDatabase(),
): Promise<{ context: string; errors: string[] }> {
  const documents = await listLegalMonitorDocuments(userId, monitorId, db);
  const sections: string[] = [];
  const errors: string[] = [];
  let remaining = MAX_CONTEXT_CHARS;

  for (const [index, document] of documents.entries()) {
    if (remaining <= 0) break;
    const { data: row, error } = await db
      .from("documents")
      .select(
        "id, user_id, project_id, library_kind, status, current_version_id, updated_at",
      )
      .eq("id", document.id)
      .eq("user_id", userId)
      .is("project_id", null)
      .maybeSingle();
    if (error || !row) {
      errors.push(
        `Library context: ${document.filename} is no longer available.`,
      );
      continue;
    }
    const rows = [row as DocumentRow];
    await attachActiveVersionPaths(db, rows);
    const active = rows[0];
    if (!active.storage_path || !active.file_type) {
      errors.push(
        `Library context: ${document.filename} has no readable version.`,
      );
      continue;
    }

    const label = `reference-${index + 1}`;
    const text = await readDocumentContent(
      label,
      new Map([
        [
          label,
          {
            storage_path: active.storage_path,
            file_type: active.file_type,
            filename: active.filename || document.filename,
          },
        ],
      ]),
      () => {},
      {
        [label]: {
          document_id: active.id,
          filename: active.filename || document.filename,
          version_id: active.current_version_id,
          version_number: active.active_version_number,
        },
      },
      db,
      { emitEvents: false },
    );
    if (
      !text.trim() ||
      text === "Document could not be read." ||
      text === "Document not found."
    ) {
      errors.push(`Library context: ${document.filename} could not be read.`);
      continue;
    }

    const content = text.slice(0, Math.min(MAX_DOCUMENT_CHARS, remaining));
    sections.push(
      [
        `REFERENCE FILE: ${document.filename}`,
        `Document ID: ${document.id}`,
        `Active version: ${document.versionNumber ?? "unknown"}`,
        "CONTENT:",
        content,
      ].join("\n"),
    );
    remaining -= content.length;
  }

  return { context: sections.join("\n\n---\n\n"), errors };
}
