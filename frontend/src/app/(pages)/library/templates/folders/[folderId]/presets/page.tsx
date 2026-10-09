"use client";

import { PresetTemplatesPage } from "@/app/components/library/PresetTemplatesPage";
import { usePathParams } from "@/app/lib/usePathParams";

// Dev (OSS-6 static export): the folder id comes from the live URL, not
// `use(params)`; the parent `[folderId]/layout.tsx` gates on it.
export default function LibraryTemplateFolderPresetsPage() {
    const { folderId } = usePathParams<"folderId">(
        "/library/templates/folders/:folderId/presets",
    );
    return <PresetTemplatesPage folderId={folderId} />;
}
