export const OPENCODE_GO_MODEL_PREFIX = "opencode-go/";
export const OPENCODE_GO_API_BASE_URL = "https://opencode.ai/zen/go/v1";

export type OpenCodeGoModelOption = {
    id: string;
    label: string;
    group: "OpenCode Go";
};

export function isOpenCodeGoModelId(id: string): boolean {
    if (!id.startsWith(OPENCODE_GO_MODEL_PREFIX)) return false;
    const apiId = id.slice(OPENCODE_GO_MODEL_PREFIX.length);
    return (
        apiId.length > 0 &&
        apiId.length <= 256 &&
        apiId.trim() === apiId &&
        !/[\s\u0000-\u001f]/u.test(apiId)
    );
}

export function openCodeGoApiModel(id: string): string | null {
    if (!isOpenCodeGoModelId(id)) return null;
    return id.slice(OPENCODE_GO_MODEL_PREFIX.length);
}

export function parseOpenCodeGoModelOptions(
    payload: unknown,
): OpenCodeGoModelOption[] {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return [];
    }
    const data = (payload as { data?: unknown }).data;
    if (!Array.isArray(data)) return [];

    const byId = new Map<string, OpenCodeGoModelOption>();
    for (const value of data) {
        if (!value || typeof value !== "object" || Array.isArray(value))
            continue;
        const row = value as Record<string, unknown>;
        const apiId = typeof row.id === "string" ? row.id.trim() : "";
        const id = `${OPENCODE_GO_MODEL_PREFIX}${apiId}`;
        if (!isOpenCodeGoModelId(id)) continue;
        const name = typeof row.name === "string" ? row.name.trim() : "";
        byId.set(id, {
            id,
            label: name || apiId,
            group: "OpenCode Go",
        });
    }

    return [...byId.values()].sort((left, right) =>
        left.label.localeCompare(right.label),
    );
}
