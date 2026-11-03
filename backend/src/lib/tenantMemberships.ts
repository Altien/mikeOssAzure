// Platform identity records are resolved before opening a tenant scope.
// Pooled sign-in (012) is the only request caller; there is deliberately no
// membership cache, so a control-plane move takes effect on the next request.
import { createPlatformSupabase, type Db } from "./supabase";

export type TenantMemberRole = "TenantAdmin" | "Member";
export interface TenantMembership {
  tenantId: string;
  role: TenantMemberRole;
}

export async function findTenantMembership(userId: string, db: Db = createPlatformSupabase()): Promise<TenantMembership | undefined> {
  const { data, error } = await db.from("tenant_memberships")
    .select("tenant_id,role,identity_kind").eq("user_id", userId).maybeSingle();
  if (error) throw new Error("Tenant membership is unavailable", { cause: error });
  if (!data || data.identity_kind !== "altien") return undefined;
  if (typeof data.tenant_id !== "string" || !data.tenant_id.trim() || !["TenantAdmin", "Member"].includes(data.role)) {
    throw new Error("Invalid tenant membership");
  }
  return { tenantId: data.tenant_id, role: data.role as TenantMemberRole };
}

export async function findIdentitySourceTenant(tid: string, db: Db = createPlatformSupabase()): Promise<string | undefined> {
  const { data, error } = await db.from("tenant_identity_sources")
    .select("tenant_id").eq("tid", tid.trim().toLowerCase()).maybeSingle();
  if (error) throw new Error("Tenant identity source is unavailable", { cause: error });
  if (!data) return undefined;
  if (typeof data.tenant_id !== "string" || !data.tenant_id.trim()) throw new Error("Invalid tenant identity source");
  return data.tenant_id;
}

/** Auth metadata only: Entra remains the authority for enterprise role assignments. */
export async function mirrorEnterpriseMembership(
  tenantId: string, userId: string, directoryId: string, role: TenantMemberRole,
  db: Db = createPlatformSupabase(),
): Promise<void> {
  const { error } = await db.rpc("mirror_enterprise_member", {
    p_tenant_id: tenantId, p_user_id: userId, p_directory_id: directoryId, p_role: role,
  });
  if (error) throw new Error("Enterprise membership is unavailable", { cause: error });
}
