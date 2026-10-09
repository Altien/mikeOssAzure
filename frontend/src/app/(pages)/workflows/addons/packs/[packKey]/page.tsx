"use client";

import { WorkflowList } from "@/app/components/workflows/WorkflowList";
import { usePathParams } from "@/app/lib/usePathParams";

export default function WorkflowAddonPackPage() {
  const { packKey } = usePathParams<"packKey">("/workflows/addons/packs/:packKey");
  return <WorkflowList initialTab="addons" packKey={packKey} />;
}
