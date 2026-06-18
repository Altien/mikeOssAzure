"use client";

import type { ReactNode } from "react";
import { ProjectWorkspaceLayout } from "@/app/components/projects/ProjectWorkspace";

// Static-export divergence (OSS-5): upstream's layout receives
// `params: Promise<{id}>` and forwards it. Under `output: "export"` those
// params are always the placeholder `"_"`, so `ProjectWorkspaceLayout`
// derives the real project id from `usePathname()` instead — this client
// layout just mounts the workspace provider around the section pages.
export default function ProjectLayout({ children }: { children: ReactNode }) {
    return <ProjectWorkspaceLayout>{children}</ProjectWorkspaceLayout>;
}
