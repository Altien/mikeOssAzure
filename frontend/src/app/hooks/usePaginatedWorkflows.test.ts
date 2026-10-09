/**
 * Select-all lifecycle for the paginated workflows list. The header checkbox
 * is disabled while `selectingAll` is true, so the flag has to come back down
 * for every request that raised it — including one that is still open when
 * the user keeps typing in the search box.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workflow } from "@/app/components/shared/types";
import {
    listSystemWorkflows,
    listWorkflowIds,
    listWorkflowsPage,
} from "@/app/lib/mikeApi";
import { usePaginatedWorkflows } from "./usePaginatedWorkflows";

vi.mock("@/app/lib/mikeApi", () => ({
    listSystemWorkflows: vi.fn(),
    listWorkflowsPage: vi.fn(),
    listWorkflowIds: vi.fn(),
}));

const listSystemWorkflowsMock = vi.mocked(listSystemWorkflows);
const listWorkflowsPageMock = vi.mocked(listWorkflowsPage);
const listWorkflowIdsMock = vi.mocked(listWorkflowIds);

function workflow(id: string): Workflow {
    return {
        id,
        user_id: "user-1",
        metadata: {
            title: `Workflow ${id}`,
            description: null,
            type: "assistant",
            contributors: [],
            language: "en",
            version: null,
            practice: null,
            jurisdictions: null,
        },
        skill_md: null,
        columns_config: null,
        is_system: false,
        created_at: "2026-09-01T00:00:00.000Z",
    };
}

describe("usePaginatedWorkflows select-all", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        listSystemWorkflowsMock.mockResolvedValue([]);
    });

    it("clears selectingAll when the search changes while the ids request is in flight", async () => {
        // 30 rows + 1 over-fetch row, so hasMore is true and select-all has
        // to go to the network.
        listWorkflowsPageMock.mockResolvedValue(
            Array.from({ length: 31 }, (_, index) => workflow(`row-${index}`)),
        );
        let resolveIds!: (rows: { id: string; user_id: string }[]) => void;
        listWorkflowIdsMock.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveIds = resolve;
                }),
        );

        const { result, rerender } = renderHook(
            ({ search }) => usePaginatedWorkflows({ search }),
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
        rerender({ search: "nda" });
        await waitFor(() => expect(result.current.loading).toBe(false));

        await act(async () => {
            resolveIds([{ id: "stale", user_id: "user-1" }]);
            await pending;
        });

        // The checkbox is usable again...
        expect(result.current.selectingAll).toBe(false);
        // ...and the ids fetched for the previous query were not applied.
        expect(result.current.selectedWorkflowIds).toEqual([]);
    });
});
