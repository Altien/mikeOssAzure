"use client";

import { OrganizationMembers } from "@/app/components/organizations/OrganizationMembers";
import { useOrganizationSettings } from "@/app/components/organizations/OrganizationSettingsShell";

export default function OrganizationMembersSettingsPage() {
  const { orgId, reload } = useOrganizationSettings();
  return (
    <OrganizationMembers
      orgId={orgId}
      onViewerRoleChanged={() => void reload()}
    />
  );
}
