import type { TenantAdminContentPage, TenantAdminOverview, TenantContentKind } from "@mike/contracts";
import type { Db } from "../../lib/supabase";
import { isPooledTenantAdmin } from "../../lib/tenantAdminAccess";
import { currentTenant } from "../../lib/tenantContext";
import { insertAuditEvent } from "../../lib/audit";
import { controlPlaneUrl } from "../../lib/controlPlaneUrl";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";

const TABLES: Record<TenantContentKind, string> = { project: "projects", chat: "chats", review: "tabular_reviews" };
export function tenantAdminStatus(): { isTenantAdmin: boolean } {
  return { isTenantAdmin: isPooledTenantAdmin() };
}
export async function tenantAdminOverview(db: Db): Promise<ServiceResult<TenantAdminOverview>> {
  if (!isPooledTenantAdmin()) return failure("forbidden", "Tenant admin access is required.");
  const actor = currentTenant()!;
  try {
    const periodStart = new Date().toISOString().slice(0, 7) + "-01";
    const [members, usage, budget, period, link] = await Promise.all([
      db.rpc("tenant_admin_members"), db.rpc("tenant_admin_usage"),
      db.from("tenant_budgets").select("monthly_credits::text,per_user_credits::text,soft_threshold::text")
        .eq("tenant_id", actor.tenantId).maybeSingle(),
      db.from("tenant_credit_periods").select("used_credits::text,reserved_credits::text")
        .eq("tenant_id", actor.tenantId).eq("period_start", periodStart).eq("subject", "").maybeSingle(),
      controlPlaneUrl(),
    ]);
    for (const result of [members, usage, budget, period]) if (result.error) return internalFailure(result.error);
    if (!Array.isArray(members.data) || !usage.data || typeof usage.data !== "object") return internalFailure(new Error("Invalid tenant summary"));
    return ok({
      tenantId: actor.tenantId, members: members.data,
      usage: usage.data as TenantAdminOverview["usage"],
      budget: {
        monthlyCredits: budget.data?.monthly_credits == null ? null : String(budget.data.monthly_credits),
        perUserCredits: budget.data?.per_user_credits == null ? null : String(budget.data.per_user_credits),
        softThreshold: budget.data?.soft_threshold == null ? null : String(budget.data.soft_threshold),
        usedCredits: String(period.data?.used_credits ?? "0"), reservedCredits: String(period.data?.reserved_credits ?? "0"),
      },
      controlPlaneUrl: link,
    });
  } catch (error) { return internalFailure(error); }
}

export async function tenantAdminContent(db: Db, args: { kind: string; offset: number; limit: number }): Promise<ServiceResult<TenantAdminContentPage>> {
  if (!isPooledTenantAdmin()) return failure("forbidden", "Tenant admin access is required.");
  if (!Object.hasOwn(TABLES, args.kind) || !Number.isSafeInteger(args.offset) || args.offset < 0
    || !Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100) return failure("validation", "Invalid content page.");
  const kind = args.kind as TenantContentKind, actor = currentTenant()!;
  try {
    let query = db.from(TABLES[kind]).select(kind === "project" ? "id,name,user_id,created_at" : "id,title,user_id,created_at,project_id")
      .eq("tenant_id", actor.tenantId);
    if (kind === "project") query = query.eq("project_kind", "workspace");
    const { data, error } = await query.order("created_at", { ascending: false }).order("id").range(args.offset, args.offset + args.limit);
    if (error) return internalFailure(error);
    // Conditional select strings are not inferable by the PostgREST type parser.
    const allRows = (data ?? []) as unknown as { id: string; name?: string; title?: string; user_id?: string | null; created_at: string; project_id?: string | null }[];
    const rows = allRows.slice(0, args.limit);
    const items: TenantAdminContentPage["items"] = rows.map(row => ({
      id: row.id, kind, title: (kind === "project" ? row.name : row.title) || "Untitled",
      ownerId: row.user_id ?? null, createdAt: row.created_at,
      ...(kind !== "project" ? { projectId: row.project_id ?? null } : {}),
    }));
    // Metadata is content too. One committed event covers this returned page.
    await insertAuditEvent(db, { userId: actor.userId!, userEmail: actor.userEmail,
      action: "tenant_admin.content_list", surface: "organisation",
      detail: { actor: actor.userId, reason: "organisation_content_listing", kind,
        objects: items.map(item => ({ id: item.id, owner: item.ownerId, kind })), offset: args.offset },
    });
    return ok({ items, hasMore: allRows.length > args.limit });
  } catch (error) { return internalFailure(error); }
}

export async function reassignTenantContent(db: Db, args: { kind: unknown; id: unknown; newOwnerId: unknown; reason: unknown }): Promise<ServiceResult<{ ok: true }>> {
  if (!isPooledTenantAdmin()) return failure("forbidden", "Tenant admin access is required.");
  if (typeof args.kind !== "string" || !Object.hasOwn(TABLES, args.kind)
    || typeof args.id !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(args.id)
    || typeof args.newOwnerId !== "string" || !args.newOwnerId.trim()
    || typeof args.reason !== "string" || args.reason.trim().length < 3 || args.reason.length > 500)
    return failure("validation", "Choose content, a new owner and a reason between 3 and 500 characters.");
  try {
    const { error } = await db.rpc("tenant_admin_reassign", { p_kind: args.kind, p_id: args.id,
      p_new_owner: args.newOwnerId, p_reason: args.reason.trim() });
    if (error) {
      if (error.code === "P0002") return failure("not_found", "Content not found.");
      if (error.code === "22023") return failure("validation", "The new owner must belong to this tenant and, for organisation content, its organisation. Shared system libraries cannot be reassigned.");
      if (error.code === "23503" || error.code === "23514") return failure("conflict", "This owner is not eligible for the content. Confirm their organisation membership and try again.");
      if (error.code === "42501") return failure("forbidden", "Tenant admin access is required.");
      return internalFailure(error);
    }
    return ok({ ok: true });
  } catch (error) { return internalFailure(error); }
}
