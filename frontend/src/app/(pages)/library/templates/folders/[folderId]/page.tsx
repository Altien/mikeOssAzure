"use client";

import { use } from "react";
import { LibraryCollectionPage } from "@/app/components/library/LibraryWorkspace";

interface Props {
    params: Promise<{ folderId: string }>;
}

export default function LibraryTemplateFolderPage({ params }: Props) {
    const { folderId } = use(params);
    return <LibraryCollectionPage kind="templates" folderId={folderId} />;
}
