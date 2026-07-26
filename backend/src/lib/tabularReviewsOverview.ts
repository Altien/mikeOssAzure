export type TabularReviewScope = "all" | "in-project" | "standalone";

export function parseTabularReviewScope(value: unknown): TabularReviewScope {
    if (value === "in-project" || value === "standalone") return value;
    return "all";
}

export interface TabularReviewsOverviewRpcArgs {
    p_user_id: string;
    p_user_email: string | null;
    p_project_id: string | null;
    p_scope: TabularReviewScope;
    p_limit: number;
    p_offset: number;
    p_search_term: string | null;
    p_sort_key: string;
    p_sort_direction: string;
}

export function buildTabularReviewsOverviewRpcArgs(params: {
    userId: string;
    userEmail: string | undefined;
    projectIdFilter: string | null;
    scope?: TabularReviewScope;
    pagination?: { limit: number; offset: number };
    searchTerm?: string | null;
    sort?: { key: string; direction: string };
}): TabularReviewsOverviewRpcArgs {
    return {
        p_user_id: params.userId,
        p_user_email: params.userEmail ?? null,
        p_project_id: params.projectIdFilter,
        p_scope: params.scope ?? "all",
        p_limit: params.pagination?.limit ?? 20,
        p_offset: params.pagination?.offset ?? 0,
        p_search_term: params.searchTerm ?? null,
        p_sort_key: params.sort?.key ?? "created",
        p_sort_direction: params.sort?.direction ?? "desc",
    };
}
