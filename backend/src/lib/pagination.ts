export interface PaginationParams {
    limit: number;
    offset: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function parsePaginationQuery(value: Record<string, unknown>): PaginationParams {
    const requestedLimit = Number.parseInt(String(value.limit ?? ""), 10);
    const requestedOffset = Number.parseInt(String(value.offset ?? ""), 10);

    const limit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), MAX_LIMIT)
        : DEFAULT_LIMIT;
    const offset = Number.isFinite(requestedOffset) && requestedOffset > 0
        ? requestedOffset
        : 0;

    return { limit, offset };
}
