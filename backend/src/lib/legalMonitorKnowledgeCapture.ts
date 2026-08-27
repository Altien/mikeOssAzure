import crypto from "node:crypto";
import type { ServerDatabase } from "./database";
import { createDocumentFromBytes } from "./documentIngest";
import { uploadFile, downloadFile, deleteFile, versionStorageKey } from "./storage";

type Db = ServerDatabase;

export const MONITOR_LIBRARY_FOLDER_NAME = "Legal Monitors";

const RUN_SECTION_PATTERN = "\n\n---\n\n## Run ";

type MonitorDevelopment = {
  title: string;
  type: string;
  date: string | null;
  url: string | null;
  citation: string | null;
  sourceName: string | null;
  whyItMatters: string;
};

async function ensureMonitorLibraryFolder(
  userId: string,
  db: Db,
): Promise<string | null> {
  const { data, error } = await db
    .from("library_folders")
    .select("id")
    .eq("user_id", userId)
    .eq("library_kind", "file")
    .eq("name", MONITOR_LIBRARY_FOLDER_NAME)
    .is("parent_folder_id", null)
    .maybeSingle();
  if (error) throw error;
  if (data?.id) return data.id as string;

  const { data: created, error: insertError } = await db
    .from("library_folders")
    .insert({
      user_id: userId,
      library_kind: "file",
      name: MONITOR_LIBRARY_FOLDER_NAME,
      parent_folder_id: null,
    })
    .select("id")
    .single();
  if (insertError) throw insertError;
  return (created?.id as string | undefined) ?? null;
}

function sanitizeFilenamePart(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "Monitor").slice(0, 80);
}

function runSectionMarkdown(params: {
  runId: string;
  completedAt: string;
  summary: string | null;
  developments: MonitorDevelopment[];
  report: string;
}): string {
  const lines: string[] = [`## Run ${params.completedAt}`, ""];
  if (params.summary?.trim()) {
    lines.push(`Summary: ${params.summary.trim()}`, "");
  }
  if (params.developments.length) {
    lines.push("### Developments", "");
    for (const development of params.developments) {
      const meta = [
        development.type,
        development.date,
        development.citation,
        development.sourceName,
      ]
        .filter(Boolean)
        .join(" · ");
      lines.push(
        `- **${development.title}**${meta ? ` (${meta})` : ""}`,
        `  ${development.whyItMatters}`,
      );
      if (development.url) lines.push(`  ${development.url}`);
    }
    lines.push("");
  }
  lines.push("### Report", "", params.report.trim());
  return lines.join("\n");
}

/**
 * Prepends a new run section ahead of the prior run sections in `previous`
 * (newest first), regenerating the header. Nothing is removed: prior run
 * sections are retained verbatim beneath the new one.
 */
export function mergeKnowledgebaseMarkdown(params: {
  monitorName: string;
  completedAt: string;
  newRunSection: string;
  previous: string;
}): string {
  const header = `# ${params.monitorName} — Knowledgebase\n\nUpdated: ${params.completedAt}\n`;
  const priorRunStart = params.previous.indexOf("## Run ");
  const priorRuns = priorRunStart >= 0 ? params.previous.slice(priorRunStart) : "";

  return priorRuns
    ? `${header}\n${params.newRunSection}${RUN_SECTION_PATTERN}${priorRuns.trimStart()}`
    : `${header}\n${params.newRunSection}\n`;
}

async function loadExistingKnowledgebase(
  userId: string,
  documentId: string,
  db: Db,
): Promise<{ text: string; maxVersionNumber: number } | null> {
  const { data: doc, error } = await db
    .from("documents")
    .select("id, current_version_id")
    .eq("id", documentId)
    .eq("user_id", userId)
    .is("project_id", null)
    .maybeSingle();
  if (error) throw error;
  if (!doc) return null;

  const { data: versions, error: versionsError } = await db
    .from("document_versions")
    .select("id, version_number, storage_path")
    .eq("document_id", documentId);
  if (versionsError) throw versionsError;
  const rows = (versions ?? []) as {
    id: string;
    version_number: number | string;
    storage_path: string;
  }[];
  const maxVersionNumber = rows.reduce(
    (max, row) => Math.max(max, Number(row.version_number) || 0),
    0,
  );
  const active = rows.find((row) => row.id === doc.current_version_id);
  if (!active) return { text: "", maxVersionNumber };

  const bytes = await downloadFile(active.storage_path).catch(() => null);
  return {
    text: bytes ? Buffer.from(bytes).toString("utf8") : "",
    maxVersionNumber,
  };
}

/**
 * Upserts the monitor's living Library knowledgebase: a single Markdown
 * document (Library › Legal Monitors) that accumulates knowledge like a
 * student's notebook. When `consolidate` is provided and prior content
 * exists, it is asked to weave the new run into the existing document —
 * preserving still-valid entries, merging duplicates, and marking
 * superseded facts — instead of blindly appending. Any consolidation
 * failure falls back to prepend-only merging, so knowledge is never lost;
 * every update is also stored as a new document version. Creates the
 * document on first use and links it back to the monitor row. Throws on
 * storage/DB failure; callers decide whether a capture failure is fatal.
 */
export async function upsertMonitorKnowledgebase(params: {
  userId: string;
  monitorId: string;
  monitorName: string;
  existingDocumentId: string | null;
  runId: string;
  completedAt: string;
  summary: string | null;
  developments: MonitorDevelopment[];
  report: string;
  db: Db;
  consolidate?: (
    previousKnowledge: string,
    newRunSection: string,
  ) => Promise<string | null>;
}): Promise<{ documentId: string; filename: string; created: boolean; consolidated: boolean }> {
  const filename = `${sanitizeFilenamePart(params.monitorName)} — Knowledgebase.md`;
  const newRunSection = runSectionMarkdown(params);

  const existing = params.existingDocumentId
    ? await loadExistingKnowledgebase(params.userId, params.existingDocumentId, params.db)
    : null;

  let merged: string;
  let consolidated = false;
  if (existing?.text.trim() && params.consolidate) {
    try {
      const result = await params.consolidate(existing.text, newRunSection);
      if (result?.trim()) {
        merged = result.trim();
        consolidated = true;
      } else {
        merged = mergeKnowledgebaseMarkdown({
          monitorName: params.monitorName,
          completedAt: params.completedAt,
          newRunSection,
          previous: existing.text,
        });
      }
    } catch {
      merged = mergeKnowledgebaseMarkdown({
        monitorName: params.monitorName,
        completedAt: params.completedAt,
        newRunSection,
        previous: existing.text,
      });
    }
  } else {
    merged = mergeKnowledgebaseMarkdown({
      monitorName: params.monitorName,
      completedAt: params.completedAt,
      newRunSection,
      previous: existing?.text ?? "",
    });
  }
  const content = Buffer.from(merged, "utf8");

  if (!existing) {
    const folderId = await ensureMonitorLibraryFolder(params.userId, params.db);
    const result = await createDocumentFromBytes({
      userId: params.userId,
      projectId: null,
      filename,
      content,
      source: "generated",
      db: params.db,
      libraryKind: "file",
      libraryFolderId: folderId,
    });
    if (!result.ok) throw new Error(result.detail);
    const documentId = result.document.id;
    const { error: linkError } = await params.db
      .from("legal_monitors")
      .update({ knowledge_document_id: documentId })
      .eq("id", params.monitorId)
      .eq("user_id", params.userId);
    if (linkError) throw linkError;
    return { documentId, filename, created: true, consolidated };
  }

  const documentId = params.existingDocumentId!;
  const versionSlug = crypto.randomUUID();
  const key = versionStorageKey(params.userId, documentId, versionSlug, filename);
  let uploaded = false;
  try {
    await uploadFile(
      key,
      content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      ) as ArrayBuffer,
      "text/markdown",
    );
    uploaded = true;

    const { data: versionRow, error: versionError } = await params.db
      .from("document_versions")
      .insert({
        document_id: documentId,
        storage_path: key,
        pdf_storage_path: null,
        source: "generated",
        version_number: existing.maxVersionNumber + 1,
        filename,
        file_type: "md",
        size_bytes: content.byteLength,
        page_count: null,
      })
      .select("id")
      .single();
    if (versionError || !versionRow) {
      throw new Error(versionError?.message ?? "failed to record version");
    }

    const { error: docError } = await params.db
      .from("documents")
      .update({
        current_version_id: versionRow.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", documentId)
      .eq("user_id", params.userId);
    if (docError) {
      await params.db.from("document_versions").delete().eq("id", versionRow.id);
      throw docError;
    }
    return { documentId, filename, created: false, consolidated };
  } catch (error) {
    if (uploaded) await deleteFile(key).catch(() => {});
    throw error;
  }
}
