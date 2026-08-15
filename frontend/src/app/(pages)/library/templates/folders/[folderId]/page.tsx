"use client";

import { LibraryCollectionPage } from "@/app/components/library/LibraryWorkspace";
import { usePathParams } from "@/app/lib/usePathParams";

export default function LibraryTemplateFolderPage() {
    const { folderId } = usePathParams<"folderId">("/library/templates/folders/:folderId");
    return <LibraryCollectionPage kind="templates" folderId={folderId} />;
}
