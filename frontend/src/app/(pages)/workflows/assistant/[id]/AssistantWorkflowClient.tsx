"use client";

import { usePathname } from "next/navigation";
import { WorkflowDetailPage } from "@/app/components/workflows/WorkflowDetailPage";

export default function AssistantWorkflowClient() {
    // Read id from the live URL — useParams() reports the prerender's
    // "_" placeholder under output: "export". See ProjectPage.tsx for
    // the full diagnosis.
    const pathname = usePathname() ?? "";
    const match = pathname.match(/^\/workflows\/assistant\/([^/?#]+)/);
    const rawId = match?.[1] ?? "";
    const id = rawId && rawId !== "_" ? decodeURIComponent(rawId) : "";
    return <WorkflowDetailPage id={id} workflowType="assistant" />;
}
