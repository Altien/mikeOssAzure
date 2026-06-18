"use client";

import { ProjectDocumentsView } from "@/app/components/projects/ProjectDocumentsView";
import { useProjectWorkspace } from "@/app/components/projects/ProjectWorkspace";

// Static-export divergence (OSS-5): the project id is resolved from the URL
// by `ProjectWorkspaceLayout` and exposed via the workspace context, so the
// documents view reads it from there rather than from server-baked params.
export function DocumentsSection() {
    const { projectId } = useProjectWorkspace();
    return <ProjectDocumentsView projectId={projectId} />;
}
