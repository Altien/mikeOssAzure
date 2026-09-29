"use client";

import { ProjectDocumentsView } from "@/app/components/projects/ProjectDocumentsView";
import { usePathParams } from "@/app/lib/usePathParams";

export default function ProjectDetailPage() {
    // Static-export divergence (OSS-6): id from the live URL instead of
    // `use(params)` (always "_" under output: "export"; see ../layout.tsx).
    const { id } = usePathParams<"id">("/projects/:id");
    return <ProjectDocumentsView projectId={id} />;
}
