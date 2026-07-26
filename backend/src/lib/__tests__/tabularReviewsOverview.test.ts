import { describe, expect, it } from "vitest";
import { buildTabularReviewsOverviewRpcArgs } from "../tabularReviewsOverview";

describe("buildTabularReviewsOverviewRpcArgs", () => {
    it("builds the full RPC payload when the paginated signature is requested", () => {
        expect(
            buildTabularReviewsOverviewRpcArgs({
                userId: "user-1",
                userEmail: "user@example.com",
                projectIdFilter: "project-1",
                pagination: { limit: 25, offset: 10 },
                searchTerm: "merger",
                sort: { key: "name", direction: "asc" },
            }),
        ).toEqual({
            p_user_id: "user-1",
            p_user_email: "user@example.com",
            p_project_id: "project-1",
            p_limit: 25,
            p_offset: 10,
            p_search_term: "merger",
            p_sort_key: "name",
            p_sort_direction: "asc",
        });
    });

    it("uses default pagination and sort values when omitted", () => {
        expect(
            buildTabularReviewsOverviewRpcArgs({
                userId: "user-1",
                userEmail: undefined,
                projectIdFilter: null,
            }),
        ).toEqual({
            p_user_id: "user-1",
            p_user_email: null,
            p_project_id: null,
            p_limit: 20,
            p_offset: 0,
            p_search_term: null,
            p_sort_key: "created",
            p_sort_direction: "desc",
        });
    });
});
