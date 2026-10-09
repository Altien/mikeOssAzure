"use client";

import { LibraryCollectionPage } from "@/app/components/library/LibraryWorkspace";
import { usePathParams } from "@/app/lib/usePathParams";

export default function LibraryFolderPage() {
    const { folderId } = usePathParams<"folderId">("/library/folders/:folderId");
    return <LibraryCollectionPage kind="files" folderId={folderId} />;
}
