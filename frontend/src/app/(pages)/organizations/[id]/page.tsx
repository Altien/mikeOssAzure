"use client";

import { use } from "react";
import { OrganizationWorkspace } from "@/app/components/organizations/OrganizationWorkspace";

export default function OrganizationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <OrganizationWorkspace orgId={id} />;
}
