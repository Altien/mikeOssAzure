import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TabularReview } from "@/app/components/shared/types";
import { listTabularReviewIds, listTabularReviews } from "@/app/lib/mikeApi";
import { usePaginatedTabularReviews } from "./usePaginatedTabularReviews";

vi.mock("@/app/lib/mikeApi", () => ({
    listTabularReviews: vi.fn(),
    listTabularReviewIds: vi.fn(),
}));

const listTabularReviewsMock = vi.mocked(listTabularReviews);
const listTabularReviewIdsMock = vi.mocked(listTabularReviewIds);

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

    it("blocks select all until the debounced search matches the typed search", async () => {
        const firstPageRows = Array.from({ length: 21 }, (_, index) =>
            review(`row-${index}`),
        );
        listTabularReviewsMock.mockResolvedValue(firstPageRows);

        const { result, rerender } = renderHook(
            ({ search, selectionKey }) =>
                usePaginatedTabularReviews({ search, selectionKey }),
            {
                initialProps: {
                    search: "",
                    selectionKey: "",
                },
            },
        );
        await waitFor(() => expect(result.current.loading).toBe(false));

        rerender({ search: "", selectionKey: "new search" });
        expect(result.current.selectingAll).toBe(true);

        await act(async () => {
            await result.current.selectAllMatching();
        });
        expect(listTabularReviewIdsMock).not.toHaveBeenCalled();
        expect(result.current.selectedReviewIds).toEqual([]);

        const matchingIds = [{ id: "matching", user_id: "user-1" }];
        listTabularReviewIdsMock.mockResolvedValueOnce(matchingIds);
        rerender({ search: "new search", selectionKey: "new search" });
        expect(result.current.selectingAll).toBe(false);

        await act(async () => {
            await result.current.selectAllMatching();
        });
        expect(listTabularReviewIdsMock).toHaveBeenCalledWith(undefined, {
            search: "new search",
            scope: "all",
        });
        expect(result.current.selectedReviewIds).toEqual(["matching"]);
    });

    it("clears a row selected during a debounced query transition", async () => {
        listTabularReviewsMock.mockResolvedValue([review("old-row")]);

        const { result, rerender } = renderHook(
            ({ search, selectionKey }) =>
                usePaginatedTabularReviews({ search, selectionKey }),
            {
                initialProps: {
                    search: "old",
                    selectionKey: "old",
                },
            },
        );
        await waitFor(() => expect(result.current.loading).toBe(false));

        rerender({ search: "old", selectionKey: "new" });
        act(() => result.current.setSelectedReviewIds(["old-row"]));
        expect(result.current.selectedReviewIds).toEqual(["old-row"]);

        rerender({ search: "new", selectionKey: "new" });
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
        await waitFor(() =>
            expect(result.current.reviews).toEqual([review("new")]),
        );
        expect(result.current.error).toBeNull();
    });

    it("exposes initial-load errors and retries the query", async () => {
        listTabularReviewsMock
            .mockRejectedValueOnce(new Error("network unavailable"))
            .mockResolvedValueOnce([review("retry")]);

        const { result } = renderHook(() => usePaginatedTabularReviews({}));

        await waitFor(() =>
            expect(result.current.error?.message).toBe("network unavailable"),
        );
        act(() => result.current.retry());

        await waitFor(() =>
            expect(result.current.reviews).toEqual([review("retry")]),
        );
        expect(result.current.error).toBeNull();
    });

    it("selects every review matching the filters via a single lightweight ids request", async () => {
        // First page load: 30 rows + 1 to signal more pages exist.
        const firstPageRows = Array.from({ length: 31 }, (_, i) =>
            review(`row-${i}`),
        );
        listTabularReviewsMock.mockResolvedValueOnce(firstPageRows);

        const { result } = renderHook(() =>
            usePaginatedTabularReviews({ scope: "in-project" }),
        );
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.reviews).toHaveLength(30);
        expect(result.current.hasMore).toBe(true);

        // selectAllMatching should ask for ids only (not full review rows) —
        // this stands in for a filter match spanning far more than one page.
        const allMatches = Array.from({ length: 150 }, (_, i) => ({
            id: `all-${i}`,
            user_id: "user-1",
        }));
        listTabularReviewIdsMock.mockResolvedValueOnce(allMatches);

        await act(async () => {
            await result.current.selectAllMatching();
        });

        const expectedIds = allMatches.map((row) => row.id);
        expect(result.current.selectedReviewIds).toEqual(expectedIds);

        // It's a single round trip for ids/owners, not a loop over full pages.
        expect(listTabularReviewIdsMock).toHaveBeenCalledTimes(1);
        expect(listTabularReviewIdsMock).toHaveBeenCalledWith(undefined, {
            search: undefined,
            scope: "in-project",
        });
        // No extra calls to the full-row endpoint beyond the initial page load.
        expect(listTabularReviewsMock).toHaveBeenCalledTimes(1);

        // Ids beyond the loaded page still resolve an owner for bulk actions
        // (e.g. delete) that need to know who can delete each selection.
        expect(result.current.getReviewOwnerId("all-149")).toBe("user-1");
        expect(result.current.getReviewOwnerId("row-0")).toBe("user-1");
    });

    it("selects already-loaded reviews without a network request once everything is loaded", async () => {
        listTabularReviewsMock.mockResolvedValueOnce([
            review("one"),
            review("two"),
        ]);

        const { result } = renderHook(() => usePaginatedTabularReviews({}));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.hasMore).toBe(false);

        await act(async () => {
            await result.current.selectAllMatching();
        });

        expect(listTabularReviewIdsMock).not.toHaveBeenCalled();
        expect(result.current.selectedReviewIds).toEqual(["one", "two"]);
    });
});
