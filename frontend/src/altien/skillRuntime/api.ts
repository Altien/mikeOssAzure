import { apiRequest } from "@/app/lib/mikeApi";

/**
 * The skill a project chat is bound to, plus whether a newer enabled version
 * exists. Reading this never changes the binding — an upgrade only happens
 * when the member presses the upgrade control, which calls
 * `upgradeChatSkill` with the exact version they were shown.
 */
export type ChatSkillBinding = {
    skillId: string;
    versionId: string;
    displayName: string;
    contentHash: string;
    dependencyVersions: unknown[];
    selectedDocumentIds: string[];
    availableUpgrade: { versionId: string; contentHash: string } | null;
};

/**
 * The skill binding summary `GET /chat/:id` returns as `skill_binding`,
 * surfaced by `getChat()` as `skillBinding`. Lives here (not in upstream's
 * `shared/types.ts`) so the upstream types file stays verbatim (OSS-6).
 */
export type ChatDetailSkillBinding = {
    skillId: string;
    versionId: string;
    displayName: string;
    contentHash: string;
    dependencyVersions: unknown[];
};

export function getChatSkillBinding(projectId: string, chatId: string) {
    return apiRequest<{ binding: ChatSkillBinding | null }>(
        `/projects/${encodeURIComponent(projectId)}/chat/${encodeURIComponent(chatId)}/skill`,
    );
}

export function upgradeChatSkill(
    projectId: string,
    chatId: string,
    toVersionId: string,
) {
    return apiRequest<{
        chatId: string;
        skillId: string;
        displayName: string;
        previousVersionId: string;
        versionId: string;
        contentHash: string;
    }>(
        `/projects/${encodeURIComponent(projectId)}/chat/${encodeURIComponent(chatId)}/skill/upgrade`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ toVersionId }),
        },
    );
}
