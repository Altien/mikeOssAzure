import { describe, expect, it, vi } from "vitest";
import { deleteTabularReviewsWithConcurrency } from "./deleteTabularReviewsWithConcurrency";

describe("deleteTabularReviewsWithConcurrency", () => {
    it("limits concurrent requests and reports only confirmed deletions", async () => {
        let activeRequests = 0;
        let maxActiveRequests = 0;
        const deleteReview = vi.fn(async (reviewId: string) => {
            activeRequests += 1;
            maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
            await new Promise((resolve) => setTimeout(resolve, 1));
            activeRequests -= 1;
            if (reviewId === "review-3" || reviewId === "review-7")
                throw new Error("delete failed");
        });
        const reviewIds = Array.from(
            { length: 10 },
            (_, index) => `review-${index}`,
        );

        const result = await deleteTabularReviewsWithConcurrency(
            reviewIds,
            deleteReview,
            3,
        );

        expect(maxActiveRequests).toBeLessThanOrEqual(3);
        expect(deleteReview).toHaveBeenCalledTimes(10);
        expect(result.deletedIds).toEqual(
            reviewIds.filter((id) => id !== "review-3" && id !== "review-7"),
        );
        expect(result.failedIds).toEqual(["review-3", "review-7"]);
    });

    it("deduplicates ids before deleting", async () => {
        const deleteReview = vi.fn().mockResolvedValue(undefined);

        const result = await deleteTabularReviewsWithConcurrency(
            ["review-1", "review-1", "review-2"],
            deleteReview,
        );

        expect(deleteReview).toHaveBeenCalledTimes(2);
        expect(result).toEqual({
            deletedIds: ["review-1", "review-2"],
            failedIds: [],
        });
    });
});
