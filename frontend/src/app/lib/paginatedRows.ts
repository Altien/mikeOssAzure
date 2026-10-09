export function splitOverfetchedPage<T>(rows: T[], pageSize: number) {
    return {
        hasMore: rows.length > pageSize,
        rows: rows.slice(0, pageSize),
    };
}

export function appendUniqueRows<T extends { id: string }>(
    current: T[],
    next: T[],
) {
    const existingIds = new Set(current.map((row) => row.id));
    return [...current, ...next.filter((row) => !existingIds.has(row.id))];
}

export function paginationError(value: unknown, fallback: string) {
    return value instanceof Error ? value : new Error(fallback);
}
