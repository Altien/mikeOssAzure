import type { ReactNode } from "react";
import { RequirePathParams } from "@/app/lib/usePathParams";

export function generateStaticParams() {
    return [{ folderId: "_" }];
}

export default function ProjectFolderLayout({ children }: { children: ReactNode }) {
    return <RequirePathParams pattern="/projects/:id/folders/:folderId">{children}</RequirePathParams>;
}
