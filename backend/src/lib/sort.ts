export type TabularReviewSortKey = "name" | "columns" | "documents" | "created";
export type TabularReviewSortDirection = "asc" | "desc";

export interface TabularReviewSort {
    key: TabularReviewSortKey;
    direction: TabularReviewSortDirection;
}

const SUPPORTED_KEYS: TabularReviewSortKey[] = ["name", "columns", "documents", "created"];

export function parseTabularReviewSort(value: Record<string, unknown>): TabularReviewSort {
    const rawKey = typeof value.sort_key === "string"
        ? value.sort_key
        : typeof value.key === "string"
            ? value.key
            : null;
    const key = rawKey && SUPPORTED_KEYS.includes(rawKey as TabularReviewSortKey)
        ? (rawKey as TabularReviewSortKey)
        : "created";
    const direction = value.sort_direction === "asc" || value.direction === "asc" ? "asc" : "desc";

    return { key, direction };
}

export type ProjectSortKey = "name" | "cm" | "files" | "chats" | "reviews" | "created";
export type ProjectSortDirection = "asc" | "desc";

export interface ProjectSort {
    key: ProjectSortKey;
    direction: ProjectSortDirection;
}

const PROJECT_SUPPORTED_KEYS: ProjectSortKey[] = ["name", "cm", "files", "chats", "reviews", "created"];

export function parseProjectSort(value: Record<string, unknown>): ProjectSort {
    const rawKey = typeof value.sort_key === "string"
        ? value.sort_key
        : typeof value.key === "string"
            ? value.key
            : null;
    const key = rawKey && PROJECT_SUPPORTED_KEYS.includes(rawKey as ProjectSortKey)
        ? (rawKey as ProjectSortKey)
        : "created";
    const direction = value.sort_direction === "asc" || value.direction === "asc" ? "asc" : "desc";

    return { key, direction };
}
