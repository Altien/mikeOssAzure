import type { ResourceAccessScope } from "./types";

interface AccessScopeLabelProps {
  scope?: ResourceAccessScope;
  organizationName?: string | null;
  directGrantCount?: number;
}

const ACCESS_SCOPE_DETAILS = {
  private: { label: "Private" },
  shared: { label: "Shared" },
  organization: { label: "Organisation" },
} as const;

export function AccessScopeLabel({
  scope = "private",
  organizationName,
  directGrantCount,
}: AccessScopeLabelProps) {
  const detail = ACCESS_SCOPE_DETAILS[scope];
  const hasDirectGrantCount =
    scope === "shared" &&
    typeof directGrantCount === "number" &&
    Number.isInteger(directGrantCount) &&
    directGrantCount >= 0;
  const accessUserCount = hasDirectGrantCount ? directGrantCount + 1 : null;
  const label =
    scope === "organization" && organizationName
      ? organizationName
      : hasDirectGrantCount
        ? `${accessUserCount} ${accessUserCount === 1 ? "user" : "users"}`
        : detail.label;
  const description =
    scope === "organization"
      ? organizationName
        ? `Shared with ${organizationName}`
        : "Shared with an organisation"
      : hasDirectGrantCount
        ? `Shared with ${accessUserCount} ${accessUserCount === 1 ? "user" : "users"}`
        : detail.label;

  return (
    <span
      aria-label={description}
      className="inline-flex min-w-0 items-center text-xs text-gray-600"
      title={description}
    >
      <span className="truncate">{label}</span>
    </span>
  );
}
