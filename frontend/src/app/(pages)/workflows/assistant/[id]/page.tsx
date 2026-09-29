"use client";

import { WorkflowDetailPage } from "@/app/components/workflows/WorkflowDetailPage";
import { usePathParams } from "@/app/lib/usePathParams";

export default function AssistantWorkflowPage() {
    // Upstream divergence (sync-log: 3132e04; OSS-6): id from the live URL
    // instead of `use(params)` (always "_" under output: "export"; see
    // layout.tsx).
    const { id } = usePathParams<"id">("/workflows/assistant/:id");
    return <WorkflowDetailPage id={id} workflowType="assistant" />;
}
