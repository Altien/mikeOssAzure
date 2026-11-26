import type { Db } from "./supabase";

/** Keep download credentials out of persisted events and history responses. */
export function stripDownloadUrls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripDownloadUrls) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "download_url")
    .map(([key, item]) => [key, stripDownloadUrls(item)])) as T;
}

/**
 * Older events sometimes stored only a relative token URL. Its encoded path
 * is a lookup hint, never an authorization credential: the tenant-scoped DB
 * resolves live versions, and /file rechecks document access on every click.
 * Expired tokens therefore need not be revived to read an old transcript.
 */
export async function hydrateDownloadHistory<T>(value: T, db: Db): Promise<T> {
  const paths = new Set<string>();
  const pathFor = (item: Record<string, unknown>): string | null => {
    if (!["doc_created", "doc_edited", "doc_download"].includes(String(item.type))) return null;
    if (typeof item.download_url !== "string") return null;
    const match = /^\/(?:api\/)?download\/([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/.exec(item.download_url);
    if (!match) return null;
    try {
      const payload = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")) as { p?: unknown };
      return typeof payload.p === "string" && payload.p ? payload.p : null;
    } catch { return null; }
  };
  const collect = (item: unknown): void => {
    if (Array.isArray(item)) { item.forEach(collect); return; }
    if (!item || typeof item !== "object") return;
    const row = item as Record<string, unknown>;
    if (!row.document_id || !row.version_id) { const path = pathFor(row); if (path) paths.add(path); }
    Object.values(row).forEach(collect);
  };
  collect(value);
  const versions = new Map<string, { id: string; document_id: string; version_number: number | null }>();
  if (paths.size) {
    const { data } = await db.from("document_versions").select("id, document_id, storage_path, version_number")
      .in("storage_path", [...paths]).is("deleted_at", null);
    for (const row of data ?? []) versions.set(row.storage_path, row);
  }
  const patch = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(patch);
    if (!item || typeof item !== "object") return item;
    const row = item as Record<string, unknown>;
    const path = pathFor(row);
    const version = path ? versions.get(path) : undefined;
    const clean = Object.fromEntries(Object.entries(row).filter(([key]) => key !== "download_url")
      .map(([key, child]) => [key, patch(child)]));
    if (version && (!row.document_id || row.document_id === version.document_id)) {
      clean.document_id = row.document_id || version.document_id;
      clean.version_id = row.version_id || version.id;
      clean.version_number = row.version_number ?? version.version_number;
    }
    return clean;
  };
  return patch(value) as T;
}
