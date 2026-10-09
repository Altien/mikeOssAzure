import type { ReactNode } from "react";
import { ProjectWorkspaceFromPath } from "./ProjectWorkspaceFromPath";

// Static-export divergence (OSS-5 / OSS-6, decision 2): upstream's layout is
// a client component that forwards `params: Promise<{id}>` to
// `ProjectWorkspaceLayout`. Under `output: "export"` those params are always
// the `"_"` placeholder, so this is a server layout that (a) declares the
// placeholder shell via `generateStaticParams` for the whole `/projects/[id]`
// subtree and (b) mounts `ProjectWorkspaceFromPath`, which feeds the real
// project id (from `usePathname()`) into upstream's unchanged
// `ProjectWorkspaceProvider`.
export function generateStaticParams() {
    return [{ id: "_" }];
}

export default function ProjectLayout({ children }: { children: ReactNode }) {
    return <ProjectWorkspaceFromPath>{children}</ProjectWorkspaceFromPath>;
}
