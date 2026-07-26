import {
    API_BASE,
    apiRequest,
    getAuthHeader,
} from "@/app/lib/mikeApi";
import { bounceIfUnauthorized } from "@/lib/auth-token";

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

export function setProjectSkillPin(
    projectId: string,
    skillId: string,
    versionId: string,
) {
    return apiRequest<{
        projectId: string;
        skillId: string;
        versionId: string;
        contentHash: string;
    }>(
        `/altien/skills/projects/${encodeURIComponent(projectId)}/pins/${encodeURIComponent(skillId)}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ versionId }),
        },
    );
}

export function disableSkill(skillId: string) {
    return apiRequest<{ skillId: string; disabledVersionId: string | null }>(
        `/altien/skills/${encodeURIComponent(skillId)}/disable`,
        { method: "POST" },
    );
}

export type SkillPackageInfo = {
    versionId: string;
    skillName: string;
    state: string;
    originalAvailable: boolean;
    mikePackageAvailable: boolean;
    developerPackageAvailable: boolean;
    developerArtifactCount: number;
    licencePaths: string[];
    fileCount: number;
    treeHash: string;
};

export function getSkillPackageInfo(versionId: string) {
    return apiRequest<SkillPackageInfo>(
        `/altien/skills/versions/${encodeURIComponent(versionId)}/packages`,
    );
}

export async function downloadSkillPackage(
    versionId: string,
    kind: "original" | "mike" | "developer",
) {
    const auth = await getAuthHeader();
    const response = await fetch(
        `${API_BASE}/altien/skills/versions/${encodeURIComponent(versionId)}/packages/${kind}`,
        { headers: auth },
    );
    bounceIfUnauthorized(response);
    if (!response.ok) throw new Error(await response.text());
    const disposition = response.headers.get("content-disposition") ?? "";
    const utf8Name = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    const simpleName = /filename="([^"]+)"/i.exec(disposition)?.[1];
    return {
        blob: await response.blob(),
        filename: utf8Name
            ? decodeURIComponent(utf8Name)
            : simpleName || `${kind}-skill.zip`,
    };
}

export function adaptSkillName(versionId: string, newDisplayName: string) {
    return apiRequest<{
        skillId: string;
        versionId: string;
        displayName: string;
        canonicalName: string;
        treeHash: string;
    }>(
        `/altien/skills/versions/${encodeURIComponent(versionId)}/adapt/rename`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ newDisplayName }),
        },
    );
}

export function createCleanRoomDeveloperArtifact(
    versionId: string,
    requirementName: string,
) {
    return apiRequest<{
        id: string;
        requirementName: string;
        state: "draft";
        filename: string;
    }>(
        `/altien/skills/versions/${encodeURIComponent(versionId)}/developer-artifacts`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requirementName }),
        },
    );
}

export type GitHubSkillImportPolicy = {
    deploymentAllowed: boolean;
    tenantEnabled: boolean;
    effectiveEnabled: boolean;
    privateRepositoryConnectionConfigured: boolean;
    canManage: boolean;
};

export function getGitHubSkillImportPolicy() {
    return apiRequest<GitHubSkillImportPolicy>(
        "/altien/skills/settings/github",
    );
}

export function setGitHubSkillImportPolicy(enabled: boolean) {
    return apiRequest<GitHubSkillImportPolicy>(
        "/altien/skills/settings/github",
        {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled }),
        },
    );
}

export function importSkillFromGitHub(url: string) {
    return apiRequest<SkillImportResult & { provenance: unknown }>(
        "/altien/skills/imports/github",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
        },
    );
}
