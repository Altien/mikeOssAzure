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
    isUpdate?: boolean;
    version: {
        id: string;
        state: "draft" | "enabled" | "disabled";
        analysisState: "pending" | "running" | "succeeded" | "failed";
        analysisProvider?: string;
        analysisModel?: string;
        entrypointPath: string;
        declaredVersion?: string;
        contentHash: string;
        sourceKind: "zip" | "github";
        sourceRepository?: string;
        sourceCommitSha?: string;
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

export function checkGitHubSkillUpdate(versionId: string) {
    return apiRequest<{
        repository: string;
        requestedRef: string;
        selectedPath: string;
        previousCommitSha: string;
        currentCommitSha: string;
        updateAvailable: boolean;
    }>(
        `/altien/skills/versions/${encodeURIComponent(versionId)}/check-update`,
        { method: "POST" },
    );
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

/** An exact pending action the TenantAdmin may approve, amend, or reject. */
export type SkillPendingAction = {
    id: string;
    actionType:
        | "enable_version"
        | "link_prior_skill"
        | "rename_skill"
        | "acquire_dependency";
    payload: Record<string, unknown>;
    payloadHash: string;
};

export type SkillSnapshotEntry = {
    path: string;
    bytes: number;
    readable: boolean;
    inert_reason: string | null;
};

export type SkillSnapshotResult =
    | SkillSnapshotEntry[]
    | { matches: Array<{ path: string; offset: number; context: string }> }
    | { path: string; text: string; truncated: boolean };

export type SkillReviewMessageResult = {
    conversationId: string;
    outcome:
        | "proposed"
        | "amended"
        | "enabled"
        | "rejected"
        | "renamed"
        | "acquired"
        | "linked"
        | "snapshot";
    action?: SkillPendingAction;
    supersededActionId?: string;
    command?: { kind: "list" | "search" | "read" };
    result?: SkillSnapshotResult;
};

export function postSkillReviewMessage(versionId: string, message: string) {
    return apiRequest<SkillReviewMessageResult>(
        `/altien/skills/versions/${encodeURIComponent(versionId)}/review/messages`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message }),
        },
    );
}

export type SkillReview = {
    conversationId: string;
    pendingActions: Array<{
        id: string;
        action_type: SkillPendingAction["actionType"];
        payload: Record<string, unknown>;
        payload_hash: string;
    }>;
    declaredGitHubDependencies: Array<{
        name: string;
        url: string;
        repository: string;
        ref: string | null;
        path: string | null;
    }>;
    amendmentSyntax: string;
    snapshotCommandSyntax: string;
};

export function getSkillReview(versionId: string) {
    return apiRequest<SkillReview>(
        `/altien/skills/versions/${encodeURIComponent(versionId)}/review`,
    );
}

export function runSkillVersion(
    versionId: string,
    projectId: string,
    documentIds: string[] = [],
) {
    return apiRequest<{
        chatId: string;
        projectId: string;
        skill: { id: string; name: string; versionId: string; contentHash: string };
    }>(`/altien/skills/versions/${encodeURIComponent(versionId)}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, documentIds }),
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
            method: "PUT",
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
        reviewPayloadHash: string;
    }>(
        `/altien/skills/versions/${encodeURIComponent(versionId)}/developer-artifacts`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requirementName }),
        },
    );
}

export function approveCleanRoomDeveloperArtifact(
    artifactId: string,
    reviewedPayloadHash: string,
) {
    return apiRequest<{ id: string; state: "approved" }>(
        `/altien/skills/developer-artifacts/${encodeURIComponent(artifactId)}/approve`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reviewedPayloadHash }),
        },
    );
}

export async function downloadCleanRoomDeveloperArtifact(artifactId: string) {
    const auth = await getAuthHeader();
    const response = await fetch(
        `${API_BASE}/altien/skills/developer-artifacts/${encodeURIComponent(artifactId)}`,
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
            : simpleName || "clean-room-brief.md",
    };
}

export type GitHubSkillImportPolicy = {
    deploymentAllowed: boolean;
    tenantEnabled: boolean;
    effectiveEnabled: boolean;
    privateRepositoryConnectionConfigured: boolean;
    oauthAvailable: boolean;
    githubLogin: string | null;
    canManage: boolean;
};

export function getGitHubSkillImportPolicy() {
    return apiRequest<GitHubSkillImportPolicy>(
        "/altien/skills/settings/github",
    );
}

export function startGitHubSkillOAuth() {
    return apiRequest<{ authorizationUrl: string }>(
        "/altien/skills/settings/github/oauth/start",
        { method: "POST" },
    );
}

export function disconnectGitHubSkillOAuth() {
    return apiRequest<void>("/altien/skills/settings/github/oauth", {
        method: "DELETE",
    });
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
