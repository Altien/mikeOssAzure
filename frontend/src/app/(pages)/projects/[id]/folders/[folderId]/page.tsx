"use client";

import { use } from "react";
import { ProjectDocumentsView } from "@/app/components/projects/ProjectDocumentsView";

interface Props {
    params: Promise<{ id: string; folderId: string }>;
}

export default function ProjectFolderPage({ params }: Props) {
    const { id, folderId } = use(params);
    return <ProjectDocumentsView projectId={id} folderId={folderId} />;
}
