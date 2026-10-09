import type { ReactNode } from "react";
import { RequirePathParams } from "@/app/lib/usePathParams";

export function generateStaticParams() {
    return [{ folderId: "_" }];
}

export default function TemplateFolderLayout({ children }: { children: ReactNode }) {
    return <RequirePathParams pattern="/library/templates/folders/:folderId">{children}</RequirePathParams>;
}
