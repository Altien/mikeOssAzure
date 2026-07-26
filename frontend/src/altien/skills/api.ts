import { apiRequest } from "@/app/lib/mikeApi";

export type SkillListItem = {
    id: string;
    canonicalName: string;
    displayName: string;
    description: string;
    version: {
        id: string;
        state: "draft" | "enabled" | "disabled";
        analysisState: "pending" | "running" | "succeeded" | "failed";
        analysisProvider?: string;
        analysisModel?: string;
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

export function analyseSkillVersion(versionId: string) {
    return apiRequest<{
        conversationId: string;
        artifact: { provider: string; model: string; generated: unknown };
    }>(`/altien/skills/versions/${encodeURIComponent(versionId)}/analyse`, {
        method: "POST",
    });
}

export function postSkillReviewMessage(versionId: string, message: string) {
    return apiRequest<{
        conversationId: string;
        outcome: "proposed" | "enabled" | "rejected";
        action?: { id: string; payloadHash: string };
    }>(
        `/altien/skills/versions/${encodeURIComponent(versionId)}/review/messages`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message }),
        },
    );
}

export function runSkillVersion(versionId: string, projectId: string) {
    return apiRequest<{
        chatId: string;
        projectId: string;
        skill: { id: string; name: string; versionId: string; contentHash: string };
    }>(`/altien/skills/versions/${encodeURIComponent(versionId)}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
    });
}
