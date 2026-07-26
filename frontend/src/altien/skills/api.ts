import { apiRequest } from "@/app/lib/mikeApi";

export type SkillListItem = {
    id: string;
    canonicalName: string;
    displayName: string;
    description: string;
    version: {
        id: string;
        state: "draft" | "enabled" | "disabled";
        entrypointPath: string;
        declaredVersion?: string;
        contentHash: string;
    };
};

export type SkillsLibraryResponse = {
    skills: SkillListItem[];
    canManage: boolean;
};

export type SkillImportResult = {
    id: string;
    treeHash: string;
    skills: SkillListItem[];
};

export function listSkills(): Promise<SkillsLibraryResponse> {
    return apiRequest<SkillsLibraryResponse>("/altien/skills");
}

export function importSkillZip(file: File): Promise<SkillImportResult> {
    const body = new FormData();
    body.append("file", file);
    return apiRequest<SkillImportResult>("/altien/skills/imports/zip", {
        method: "POST",
        body,
    });
}
