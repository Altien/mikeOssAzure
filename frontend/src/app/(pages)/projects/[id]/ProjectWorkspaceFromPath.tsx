"use client";

import type { ReactNode } from "react";
import { ProjectWorkspaceProvider } from "@/app/components/projects/ProjectWorkspace";
import { usePathParams } from "@/app/lib/usePathParams";

// Static-export divergence (OSS-5 / OSS-6): stands in for upstream's
// `ProjectWorkspaceLayout`, which resolves the project id with
// `use(params)`. Under `output: "export"` that is always `"_"`, so the id is
// read from the live URL instead. Everything below consumes `projectId`
// from the workspace context unchanged.
export function ProjectWorkspaceFromPath({
    children,
}: {
    children: ReactNode;
}) {
    const { id } = usePathParams<"id">("/projects/:id");
    // Don't mount the provider (which fetches the project) until the real
    // id is known — the prerendered shell and the pre-hydration tick see "".
    if (!id) return null;
    return (
        <ProjectWorkspaceProvider projectId={id}>
            {children}
        </ProjectWorkspaceProvider>
    );
}
