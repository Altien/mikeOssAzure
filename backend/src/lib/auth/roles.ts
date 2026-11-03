// Role resolution from Entra group memberships. Reads the admin /
// member group ID allowlists from KV via getConfig, falling back to
// process.env on older installs (getConfig handles env-first priority).
//
// KV value format accepts comma-separated GUIDs with optional
// `# display-name` comments, matching the install configurator's
// surface (see installAuth.ts:isInAdminGroup). The comment is stripped
// before comparison so operators can self-document the KV value.

import { getConfig } from "../config.js";
import type { AuthPrincipal } from "./types";
import { createServerSupabase, type Db } from "../supabase";

export type AppRole = "TenantAdmin" | "Member";

function parseGuidList(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((value) => value.split("#")[0].trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function resolveRoles(groups: string[]): Promise<AppRole[]> {
  const [adminRaw, memberRaw] = await Promise.all([
    getConfig("entra-admin-group-ids").catch(() => ""),
    getConfig("entra-member-group-ids").catch(() => ""),
  ]);

  const adminGroupIds = parseGuidList(adminRaw);
  const memberGroupIds = parseGuidList(memberRaw);

  const userGroupsLower = groups.map((g) => g.toLowerCase());

  const matchedAdmin = userGroupsLower.some((group) => adminGroupIds.has(group));
  if (matchedAdmin) {
    return ["TenantAdmin", "Member"];
  }

  // Empty member-group means "no restriction on who can use Mike beyond
  // tenant membership." Tenant membership has already been verified by
  // the token's `tid` claim before this function runs, so granting
  // Member here is safe. Avoids forcing operators who legitimately want
  // "anyone in my tenant" to invent an artificial group. The /install
  // 'Users (who can use Mike)' row makes this default explicit in copy.
  // Closes 040 Entry 7 fix A.
  if (memberGroupIds.size === 0) {
    return ["Member"];
  }

  const matchedMember = userGroupsLower.some((group) => memberGroupIds.has(group));
  if (matchedMember) {
    return ["Member"];
  }

  return [];
}

/** Pooled policy is tenant-owned; install-wide allowlists never apply. */
export async function resolvePooledRoles(principal: AuthPrincipal, db?: Db): Promise<AppRole[]> {
  if (principal.identityKind === "altien" || principal.provider === "local") {
    return principal.membershipRole === "TenantAdmin" ? ["TenantAdmin", "Member"]
      : principal.membershipRole === "Member" ? ["Member"] : [];
  }
  if (principal.identityKind !== "enterprise" || !principal.tenantId) return [];
  const client = db ?? createServerSupabase();
  const appRoles = new Set(principal.appRoles ?? []);
  if (appRoles.has("Mike.Admin") || appRoles.has("Mike Admin")) return ["TenantAdmin", "Member"];
  if (appRoles.has("Mike.User") || appRoles.has("Mike User")) return ["Member"];
  // Absence of a role on ONE user is not evidence of a tenant-wide fallback.
  const { data: tenant, error: tenantError } = await client.from("tenants")
    .select("enterprise_role_source").eq("tenant_id", principal.tenantId).maybeSingle();
  if (tenantError) throw new Error("Tenant role policy is unavailable", { cause: tenantError });
  if (tenant?.enterprise_role_source !== "groups") return [];
  const { data, error } = await client.from("tenant_group_policies")
    .select("group_object_id,role").eq("tenant_id", principal.tenantId);
  if (error) throw new Error("Tenant group policy is unavailable", { cause: error });
  const groups = new Set((principal.groups ?? []).map(group => group.toLowerCase()));
  const matched = (data ?? []).filter(policy => groups.has(String(policy.group_object_id).toLowerCase()));
  if (matched.some(policy => policy.role === "TenantAdmin")) return ["TenantAdmin", "Member"];
  return matched.some(policy => policy.role === "Member") ? ["Member"] : [];
}
