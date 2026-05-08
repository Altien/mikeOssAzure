export type AppRole = "TenantAdmin" | "Member";

function toSet(csv: string | undefined): Set<string> {
  return new Set(
    (csv ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function resolveRoles(groups: string[]): AppRole[] {
  const adminGroupIds = toSet(process.env.ENTRA_ADMIN_GROUP_IDS);
  const memberGroupIds = toSet(process.env.ENTRA_MEMBER_GROUP_IDS);

  const matchedAdmin = groups.some((group) => adminGroupIds.has(group));
  if (matchedAdmin) {
    return ["TenantAdmin", "Member"];
  }

  const matchedMember = groups.some((group) => memberGroupIds.has(group));
  if (matchedMember) {
    return ["Member"];
  }

  return [];
}
