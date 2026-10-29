import type { Db } from "../../lib/supabase";
/** Existing canonical access/revision RPC, narrowed to the source path this read resolved. */
export async function readCurrentLegacyDocumentText(db: Db, params: {
  userId: string; userEmail?: string | null; documentId: string; versionId: string; storagePath: string;
}): Promise<string | null> {
  const { data, error } = await db.rpc("read_document_text", {
    p_user_id: params.userId, p_user_email: params.userEmail ?? null,
    p_document_id: params.documentId, p_version_id: params.versionId, p_expected_storage_path: params.storagePath,
  });
  if (error) throw error;
  return data?.status === "ready" && typeof data.text === "string" ? data.text : null;
}
