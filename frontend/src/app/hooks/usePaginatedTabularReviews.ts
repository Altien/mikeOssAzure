import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction,
} from "react";
import type { TabularReview } from "@/app/components/shared/types";
import { listTabularReviews } from "@/app/lib/mikeApi";

export type TabularReviewSortKey =
    | "name"
    | "columns"
    | "documents"
    | "created";
export type TabularReviewSortDirection = "asc" | "desc";
export type TabularReviewScope = "all" | "in-project" | "standalone";

const PAGE_SIZE = 20;

function pageRows(rows: TabularReview[]) {
    return {
        hasMore: rows.length > PAGE_SIZE,
        rows: rows.slice(0, PAGE_SIZE),
    };
}

function asError(value: unknown) {
    return value instanceof Error
        ? value
        : new Error("Unable to load tabular reviews");
}

export function usePaginatedTabularReviews(options: {
    projectId?: string;
    search?: string;
    selectionKey?: string;
    scope?: TabularReviewScope;
    sort?: {
        key: TabularReviewSortKey;
        direction: TabularReviewSortDirection;
    } | null;
}) {
    const [reviews, setReviews] = useState<TabularReview[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const [error, setError] = useState<Error | null>(null);
    const [loadMoreError, setLoadMoreError] = useState<Error | null>(null);
    const [retryVersion, setRetryVersion] = useState(0);
    const requestVersionRef = useRef(0);
    const loadingMoreRef = useRef(false);
    const loadMoreControllerRef = useRef<AbortController | null>(null);

    const {
        projectId,
        search,
        selectionKey,
        scope = "all",
        sort,
    } = options;
    const sortKey = sort?.key;
    const sortDirection = sort?.direction;
    const queryKey = JSON.stringify([
        projectId ?? null,
        selectionKey ?? search ?? null,
        scope,
        sortKey ?? null,
        sortDirection ?? null,
    ]);
    const [selection, setSelection] = useState<{
        queryKey: string;
        ids: string[];
    }>({ queryKey, ids: [] });
    const selectedReviewIds =
        selection.queryKey === queryKey ? selection.ids : [];
    const setSelectedReviewIds: Dispatch<SetStateAction<string[]>> = useCallback(
        (value) => {
            setSelection((current) => {
                const currentIds =
                    current.queryKey === queryKey ? current.ids : [];
                const ids =
                    typeof value === "function" ? value(currentIds) : value;
                return { queryKey, ids };
            });
        },
        [queryKey],
    );

    useEffect(() => {
        const requestVersion = ++requestVersionRef.current;
        const controller = new AbortController();
        loadMoreControllerRef.current?.abort();
        loadMoreControllerRef.current = null;
        loadingMoreRef.current = false;
        setReviews([]);
        setHasMore(true);
        setLoadingMore(false);
        setError(null);
        setLoadMoreError(null);
        setLoading(true);

        void listTabularReviews(projectId, {
            limit: PAGE_SIZE + 1,
            search: search || undefined,
            scope,
            sortKey,
            sortDirection,
            signal: controller.signal,
        })
            .then((rows) => {
                if (requestVersion !== requestVersionRef.current) return;
                const firstPage = pageRows(rows);
                setReviews(firstPage.rows);
                setHasMore(firstPage.hasMore);
            })
            .catch((error) => {
                if (
                    controller.signal.aborted ||
                    requestVersion !== requestVersionRef.current
                )
                    return;
                console.error("[tabular reviews] failed to load", error);
                setError(asError(error));
                setHasMore(false);
            })
            .finally(() => {
                if (
                    !controller.signal.aborted &&
                    requestVersion === requestVersionRef.current
                )
                    setLoading(false);
            });
        return () => {
            controller.abort();
            loadMoreControllerRef.current?.abort();
        };
    }, [
        projectId,
        retryVersion,
        scope,
        search,
        sortDirection,
        sortKey,
    ]);

    const loadMore = useCallback(async () => {
        if (loading || loadingMoreRef.current || !hasMore) return;

        const requestVersion = requestVersionRef.current;
        const offset = reviews.length;
        const controller = new AbortController();
        loadMoreControllerRef.current?.abort();
        loadMoreControllerRef.current = controller;
        loadingMoreRef.current = true;
        setLoadingMore(true);
        setLoadMoreError(null);

        try {
            const rows = await listTabularReviews(projectId, {
                limit: PAGE_SIZE + 1,
                offset,
                search: search || undefined,
                scope,
                sortKey,
                sortDirection,
                signal: controller.signal,
            });
            if (requestVersion !== requestVersionRef.current) return;

            const nextPage = pageRows(rows);
            setReviews((current) => {
                const existingIds = new Set(current.map((review) => review.id));
                return [
                    ...current,
                    ...nextPage.rows.filter(
                        (review) => !existingIds.has(review.id),
                    ),
                ];
            });
            setHasMore(nextPage.hasMore);
        } catch (error) {
            if (
                !controller.signal.aborted &&
                requestVersion === requestVersionRef.current
            ) {
                console.error("[tabular reviews] failed to load more", error);
                setLoadMoreError(asError(error));
            }
        } finally {
            if (
                requestVersion === requestVersionRef.current &&
                loadMoreControllerRef.current === controller
            ) {
                loadMoreControllerRef.current = null;
                loadingMoreRef.current = false;
                setLoadingMore(false);
            }
        }
    }, [
        hasMore,
        loading,
        projectId,
        reviews.length,
        scope,
        search,
        sortDirection,
        sortKey,
    ]);
    const retry = useCallback(() => {
        setRetryVersion((current) => current + 1);
    }, []);

    return {
        reviews,
        setReviews,
        loading,
        loadingMore,
        hasMore,
        error,
        loadMoreError,
        loadMore,
        retry,
        selectedReviewIds,
        setSelectedReviewIds,
    };
}
