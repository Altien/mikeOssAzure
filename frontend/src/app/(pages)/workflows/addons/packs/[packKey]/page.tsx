"use client";

import { use } from "react";
import { WorkflowList } from "@/app/components/workflows/WorkflowList";

interface Props {
  params: Promise<{ packKey: string }>;
}

export default function WorkflowAddonPackPage({ params }: Props) {
  const { packKey } = use(params);
  let decodedPackKey = packKey;
  try {
    decodedPackKey = decodeURIComponent(packKey);
  } catch {
    // Keep the original value if a malformed URL segment reaches this route.
  }
  return <WorkflowList initialTab="addons" packKey={decodedPackKey} />;
}
