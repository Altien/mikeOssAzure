import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TabularReview } from "@/app/components/shared/types";
import { listTabularReviews } from "@/app/lib/mikeApi";
import { usePaginatedTabularReviews } from "./usePaginatedTabularReviews";

vi.mock("@/app/lib/mikeApi", () => ({
    listTabularReviews: vi.fn(),
}));

const listTabularReviewsMock = vi.mocked(listTabularReviews);

function review(id: string): TabularReview {
    return {
        id,
        project_id: null,
        user_id: "user-1",
        title: `Review ${id}`,
        columns_config: [],
        document_ids: [],
        workflow_id: null,
        shared_with: [],
        created_at: "2026-07-27T00:00:00.000Z",
        updated_at: "2026-07-27T00:00:00.000Z",
    };
}

describe("usePaginatedTabularReviews", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("scopes selected IDs to the current search query", async () => {
        listTabularReviewsMock.mockResolvedValue([review("one")]);

        const { result, rerender } = renderHook(
            ({ search }) =>
                usePaginatedTabularReviews({
                    search,
                    selectionKey: search,
                }),
            { initialProps: { search: "" } },
        );

        await waitFor(() => expect(result.current.loading).toBe(false));
        act(() => result.current.setSelectedReviewIds(["one"]));
        expect(result.current.selectedReviewIds).toEqual(["one"]);

        rerender({ search: "another query" });
        expect(result.current.selectedReviewIds).toEqual([]);
    });

    it("aborts an obsolete request when the query changes", async () => {
        let firstSignal: AbortSignal | undefined;
        listTabularReviewsMock
            .mockImplementationOnce((_projectId, options) => {
                firstSignal = options?.signal;
                return new Promise<TabularReview[]>((_resolve, reject) => {
                    firstSignal?.addEventListener("abort", () => {
                        reject(new DOMException("Aborted", "AbortError"));
                    });
                });
            })
            .mockResolvedValueOnce([review("new")]);

        const { result, rerender } = renderHook(
            ({ search }) => usePaginatedTabularReviews({ search }),
            { initialProps: { search: "old" } },
        );
        await waitFor(() => expect(firstSignal).toBeDefined());

        rerender({ search: "new" });
        expect(firstSignal?.aborted).toBe(true);
        await waitFor(() => expect(result.current.reviews).toEqual([review("new")]));
        expect(result.current.error).toBeNull();
    });

    it("exposes initial-load errors and retries the query", async () => {
        listTabularReviewsMock
            .mockRejectedValueOnce(new Error("network unavailable"))
            .mockResolvedValueOnce([review("retry")]);

        const { result } = renderHook(() =>
            usePaginatedTabularReviews({}),
        );

        await waitFor(() =>
            expect(result.current.error?.message).toBe("network unavailable"),
        );
        act(() => result.current.retry());

        await waitFor(() =>
            expect(result.current.reviews).toEqual([review("retry")]),
        );
        expect(result.current.error).toBeNull();
    });
});
