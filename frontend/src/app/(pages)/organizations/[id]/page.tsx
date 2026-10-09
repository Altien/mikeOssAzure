"use client";

import { OrganizationWorkspace } from "@/app/components/organizations/OrganizationWorkspace";
import { usePathParams } from "@/app/lib/usePathParams";

export default function OrganizationPage() {
  const { id } = usePathParams<"id">("/organizations/:id");
  return <OrganizationWorkspace orgId={id} />;
}
