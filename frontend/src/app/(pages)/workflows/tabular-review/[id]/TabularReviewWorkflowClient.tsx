"use client";

import { usePathname } from "next/navigation";
import { WorkflowDetailPage } from "@/app/components/workflows/WorkflowDetailPage";

export default function TabularReviewWorkflowClient() {
    // Read id from the live URL — useParams() reports the prerender's
    // "_" placeholder under output: "export". See ProjectWorkspace.tsx for
    // the full diagnosis.
    const pathname = usePathname() ?? "";
    const match = pathname.match(/^\/workflows\/tabular-review\/([^/?#]+)/);
    const rawId = match?.[1] ?? "";
    const id = rawId && rawId !== "_" ? decodeURIComponent(rawId) : "";
    return <WorkflowDetailPage id={id} workflowType="tabular" />;
}
