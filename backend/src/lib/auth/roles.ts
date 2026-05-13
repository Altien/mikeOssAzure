// Role resolution from Entra group memberships. Reads the admin /
// member group ID allowlists from KV via getConfig, falling back to
// process.env on older installs (getConfig handles env-first priority).
//
// KV value format accepts comma-separated GUIDs with optional
// `# display-name` comments, matching the install configurator's
// surface (see installAuth.ts:isInAdminGroup). The comment is stripped
// before comparison so operators can self-document the KV value.
//
// Gap #1 in docs/issues/azure-migration/036-marketplace-install-gaps.md.

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

  const matchedMember = userGroupsLower.some((group) => memberGroupIds.has(group));
  if (matchedMember) {
    return ["Member"];
  }

  return [];
}
