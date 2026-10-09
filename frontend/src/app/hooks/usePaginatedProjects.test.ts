/**
 * Select-all lifecycle for the paginated projects list. The header checkbox
 * is disabled while `selectingAll` is true, so the flag has to come back down
 * for every request that raised it — including one that is still open when
 * the user keeps typing in the search box.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/app/components/shared/types";
import { listProjectIds, listProjectsPage } from "@/app/lib/mikeApi";
import { usePaginatedProjects } from "./usePaginatedProjects";

vi.mock("@/app/lib/mikeApi", () => ({
    listProjectsPage: vi.fn(),
    listProjectIds: vi.fn(),
}));

const listProjectsPageMock = vi.mocked(listProjectsPage);
const listProjectIdsMock = vi.mocked(listProjectIds);

function project(id: string): Project {
    return {
        id,
        user_id: "user-1",
        name: `Project ${id}`,
        cm_number: null,
        practice: null,
        memory_enabled: false,
        created_at: "2026-09-01T00:00:00.000Z",
        updated_at: "2026-09-01T00:00:00.000Z",
    };
}

describe("usePaginatedProjects select-all", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("clears selectingAll when the search changes while the ids request is in flight", async () => {
        // 30 rows + 1 over-fetch row, so hasMore is true and select-all has
        // to go to the network.
        listProjectsPageMock.mockResolvedValue(
            Array.from({ length: 31 }, (_, index) => project(`row-${index}`)),
        );
        let resolveIds!: (rows: { id: string; user_id: string }[]) => void;
        listProjectIdsMock.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveIds = resolve;
                }),
        );

        const { result, rerender } = renderHook(
            ({ search }) => usePaginatedProjects({ search }),
            { initialProps: { search: "" } },
        );
        await waitFor(() => expect(result.current.loading).toBe(false));

        let pending!: Promise<void>;
        act(() => {
            pending = result.current.selectAllMatching();
        });
        expect(result.current.selectingAll).toBe(true);

        // The user keeps typing: the list query is re-issued (and the list
        // request version bumps) while the ids request is still open.
        rerender({ search: "acme" });
        await waitFor(() => expect(result.current.loading).toBe(false));

        await act(async () => {
            resolveIds([{ id: "stale", user_id: "user-1" }]);
            await pending;
        });

        // The checkbox is usable again...
        expect(result.current.selectingAll).toBe(false);
        // ...and the ids fetched for the previous query were not applied.
        expect(result.current.selectedProjectIds).toEqual([]);
    });
});
