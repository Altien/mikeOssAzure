"use client";

import { use } from "react";
import { LibraryCollectionPage } from "@/app/components/library/LibraryWorkspace";

interface Props {
    params: Promise<{ folderId: string }>;
}

export default function LibraryFolderPage({ params }: Props) {
    const { folderId } = use(params);
    return <LibraryCollectionPage kind="files" folderId={folderId} />;
}
