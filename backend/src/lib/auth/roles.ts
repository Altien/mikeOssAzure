// Role resolution from Entra group memberships. Reads the admin /
// member group ID allowlists from KV via getConfig, falling back to
// process.env on older installs (getConfig handles env-first priority).
//
// KV value format accepts comma-separated GUIDs with optional
// `# display-name` comments, matching the install configurator's
// surface (see installAuth.ts:isInAdminGroup). The comment is stripped
// before comparison so operators can self-document the KV value.

import { getConfig } from "../config.js";

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
