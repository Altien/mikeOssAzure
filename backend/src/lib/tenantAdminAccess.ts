// Pooled tenant-admin access is an explicit, audited read exception.
// Ordinary resource permissions still govern all mutations and POST reads.
import type { Db } from "./supabase";
import { currentTenant } from "./tenantContext";
import { insertAuditEvent } from "./audit";

export type AdminObjectKind = "project" | "document" | "chat" | "review" | "workflow";
export const ADMIN_OBJECT_TABLES: Record<AdminObjectKind, string> = {
  project: "projects", document: "documents", chat: "chats",
  review: "tabular_reviews", workflow: "workflows",
};
export function isPooledTenantAdmin(userId?: string): boolean {
  const actor = currentTenant();
  return !!actor?.pooled && !!actor.userId && (!userId || actor.userId === userId)
    && !!actor.roles?.includes("TenantAdmin");
}
/** Re-read the real object under tenant RLS; caller-supplied owner/container fields are not trusted. */
export async function auditedAdminRead(db: Db, kind: AdminObjectKind, id: string | undefined, userId: string): Promise<boolean> {
  const actor = currentTenant();
  if (!id || !isPooledTenantAdmin(userId) || !actor?.readOnly) return false;
  const { data, error } = await db.from(ADMIN_OBJECT_TABLES[kind])
    .select("id,user_id,tenant_id").eq("id", id).eq("tenant_id", actor.tenantId).maybeSingle();
  if (error || !data || data.tenant_id !== actor.tenantId) return false;
  try {
    await insertAuditEvent(db, {
      userId, userEmail: actor.userEmail, action: "tenant_admin.content_read", surface: "organisation",
      ...(kind === "project" ? { projectId: id } : {}),
      ...(kind === "document" ? { documentId: id } : {}),
      ...(kind === "chat" ? { chatId: id } : {}),
      ...(kind === "review" ? { reviewId: id } : {}),
      detail: { actor: userId, owner: data.user_id, object: { kind, id }, reason: "tenant_admin_read" },
    });
    return true;
  } catch (error) {
    console.error("[tenant-admin] content audit failed", error);
    return false;
  }
}
