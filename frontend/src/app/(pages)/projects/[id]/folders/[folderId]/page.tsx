"use client";

import { ProjectDocumentsView } from "@/app/components/projects/ProjectDocumentsView";
import { usePathParams } from "@/app/lib/usePathParams";

export default function ProjectFolderPage() {
    const { id, folderId } = usePathParams<"id" | "folderId">("/projects/:id/folders/:folderId");
    return <ProjectDocumentsView projectId={id} folderId={folderId} />;
}
