const DEFAULT_DELETE_CONCURRENCY = 5;

export interface BulkDeleteResult {
    deletedIds: string[];
    failedIds: string[];
}

export async function deleteTabularReviewsWithConcurrency(
    reviewIds: string[],
    deleteReview: (reviewId: string) => Promise<void>,
    concurrency = DEFAULT_DELETE_CONCURRENCY,
): Promise<BulkDeleteResult> {
    const uniqueIds = [...new Set(reviewIds)];
    if (uniqueIds.length === 0) return { deletedIds: [], failedIds: [] };

    const outcomes = new Map<string, "deleted" | "failed">();
    const workerCount = Math.min(
        uniqueIds.length,
        Math.max(1, Math.floor(concurrency)),
    );
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < uniqueIds.length) {
            const reviewId = uniqueIds[nextIndex++];
            try {
                await deleteReview(reviewId);
                outcomes.set(reviewId, "deleted");
            } catch {
                outcomes.set(reviewId, "failed");
            }
        }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return {
        deletedIds: uniqueIds.filter((id) => outcomes.get(id) === "deleted"),
        failedIds: uniqueIds.filter((id) => outcomes.get(id) === "failed"),
    };
}
