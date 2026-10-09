import type { ReactNode } from "react";
import { RequirePathParams } from "@/app/lib/usePathParams";

// Static export serves one placeholder shell for every folder URL.
export function generateStaticParams() {
    return [{ folderId: "_" }];
}

export default function LibraryFolderLayout({ children }: { children: ReactNode }) {
    return <RequirePathParams pattern="/library/folders/:folderId">{children}</RequirePathParams>;
}
