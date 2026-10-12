"use client";

import { OrganizationSettings } from "@/app/components/organizations/OrganizationSettings";
import { usePathParams } from "@/app/lib/usePathParams";

// Dev static-export boundary; identity comes from the actual browser path.
export default function OrganizationSettingsPage() {
  const { id } = usePathParams<"id">("/organizations/:id/settings");
  return <OrganizationSettings key={id} orgId={id} />;
}
