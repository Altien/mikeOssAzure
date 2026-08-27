import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServerSQLite } from "../../lib/sqlite";

// SQLite-provider equivalent of tabularPagination.supabase.test.ts: proves
// the local get_tabular_reviews_overview / get_tabular_review_ids_overview
// RPC emulation in ../../lib/sqlite.ts honors the same pagination, scope,
// search, and sort contract as the Postgres RPCs in
// backend/migrations/20260726_01 and 20260727_01, since this provider has no
// database to run those migrations against.
describe("SQLite tabular-review pagination", () => {
    const db = createServerSQLite();
    const ownerId = crypto.randomUUID();
    const ownerEmail = `pagination-${ownerId}@test.local`;
    const projectId = crypto.randomUUID();
    const projectReviewIds = Array.from({ length: 25 }, () =>
        crypto.randomUUID(),
    );
    const standaloneReviewIds = Array.from({ length: 5 }, () =>
        crypto.randomUUID(),
    );
    const tiedCreatedAt = "2026-07-27T00:00:00.000Z";

    beforeAll(async () => {
        const project = await db.from("projects").insert({
            id: projectId,
            user_id: ownerId,
            name: "Pagination integration project",
        });
        if (project.error) throw project.error;

        for (const [index, id] of projectReviewIds.entries()) {
            const inserted = await db.from("tabular_reviews").insert({
                id,
                project_id: projectId,
                user_id: ownerId,
                title: "Needle Review",
                columns_config: Array.from(
                    { length: index % 5 },
                    (_, columnIndex) => ({
                        index: columnIndex,
                        name: `Column ${columnIndex}`,
                        prompt: `Prompt ${columnIndex}`,
                    }),
                ),
                document_ids: [],
                created_at: tiedCreatedAt,
                updated_at: tiedCreatedAt,
            });
            if (inserted.error) throw inserted.error;
        }

        for (const id of standaloneReviewIds) {
            const inserted = await db.from("tabular_reviews").insert({
                id,
                user_id: ownerId,
                title: "Standalone Needle",
                columns_config: [],
                document_ids: [],
                created_at: tiedCreatedAt,
                updated_at: tiedCreatedAt,
            });
            if (inserted.error) throw inserted.error;
        }
    });

    afterAll(async () => {
        for (const id of [...projectReviewIds, ...standaloneReviewIds]) {
            await db.from("tabular_reviews").delete().eq("id", id);
        }
        await db.from("projects").delete().eq("id", projectId);
    });

    it("paginates tied rows deterministically without duplicates", async () => {
        const commonArgs = {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_project_id: projectId,
            p_scope: "in-project",
            p_search_term: "needle",
            p_sort_key: "name",
            p_sort_direction: "asc",
        };
        const firstPage = await db.rpc("get_tabular_reviews_overview", {
            ...commonArgs,
            p_limit: 20,
            p_offset: 0,
        });
        const secondPage = await db.rpc("get_tabular_reviews_overview", {
            ...commonArgs,
            p_limit: 20,
            p_offset: 20,
        });

        expect(firstPage.error).toBeNull();
        expect(secondPage.error).toBeNull();
        expect(firstPage.data).toHaveLength(20);
        expect(secondPage.data).toHaveLength(5);

        const firstIds = (firstPage.data ?? []).map((row: any) => row.id);
        const secondIds = (secondPage.data ?? []).map((row: any) => row.id);
        expect(new Set([...firstIds, ...secondIds]).size).toBe(25);
        expect([...firstIds, ...secondIds]).toEqual(
            [...projectReviewIds].sort(),
        );
    });

    it("filters by scope alone (no project_id) across every accessible project", async () => {
        const inProject = await db.rpc("get_tabular_reviews_overview", {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_project_id: null,
            p_scope: "in-project",
            p_limit: 100,
            p_offset: 0,
            p_search_term: "needle",
            p_sort_key: "created",
            p_sort_direction: "desc",
        });
        const standalone = await db.rpc("get_tabular_reviews_overview", {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_project_id: null,
            p_scope: "standalone",
            p_limit: 100,
            p_offset: 0,
            p_search_term: "needle",
            p_sort_key: "created",
            p_sort_direction: "desc",
        });

        expect(inProject.error).toBeNull();
        expect(standalone.error).toBeNull();

        const inProjectIds = new Set(
            (inProject.data ?? []).map((row: any) => row.id as string),
        );
        const standaloneIds = new Set(
            (standalone.data ?? []).map((row: any) => row.id as string),
        );

        for (const id of projectReviewIds) expect(inProjectIds.has(id)).toBe(true);
        for (const id of standaloneReviewIds)
            expect(inProjectIds.has(id)).toBe(false);

        for (const id of standaloneReviewIds)
            expect(standaloneIds.has(id)).toBe(true);
        for (const id of projectReviewIds)
            expect(standaloneIds.has(id)).toBe(false);

        expect(
            (inProject.data ?? []).every((row: any) => row.project_id !== null),
        ).toBe(true);
        expect(
            (standalone.data ?? []).every((row: any) => row.project_id === null),
        ).toBe(true);
    });

    it("applies scope and search before limiting rows", async () => {
        const result = await db.rpc("get_tabular_reviews_overview", {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_project_id: null,
            p_scope: "standalone",
            p_limit: 100,
            p_offset: 0,
            p_search_term: "standalone needle",
            p_sort_key: "created",
            p_sort_direction: "desc",
        });

        expect(result.error).toBeNull();
        expect(result.data).toHaveLength(5);
        expect(
            (result.data ?? []).every((row: any) => row.project_id === null),
        ).toBe(true);
    });

    it.each(["%", "_"])(
        "treats %s as a literal search character",
        async (searchTerm) => {
            const reviews = await db.rpc("get_tabular_reviews_overview", {
                p_user_id: ownerId,
                p_user_email: ownerEmail,
                p_project_id: null,
                p_scope: "all",
                p_limit: 100,
                p_offset: 0,
                p_search_term: searchTerm,
                p_sort_key: "created",
                p_sort_direction: "desc",
            });
            const ids = await db.rpc("get_tabular_review_ids_overview", {
                p_user_id: ownerId,
                p_user_email: ownerEmail,
                p_project_id: null,
                p_scope: "all",
                p_search_term: searchTerm,
                p_limit: 100,
                p_offset: 0,
            });

            expect(reviews.error).toBeNull();
            expect(ids.error).toBeNull();
            expect(reviews.data).toEqual([]);
            expect(ids.data).toEqual([]);
        },
    );

    it("sorts the complete filtered set before pagination", async () => {
        const result = await db.rpc("get_tabular_reviews_overview", {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_project_id: projectId,
            p_scope: "in-project",
            p_limit: 25,
            p_offset: 0,
            p_search_term: null,
            p_sort_key: "columns",
            p_sort_direction: "asc",
        });

        expect(result.error).toBeNull();
        const columnCounts = (result.data ?? []).map(
            (row: any) =>
                (row.columns_config as unknown[] | null | undefined)?.length ??
                0,
        );
        expect(columnCounts).toEqual([...columnCounts].sort((a, b) => a - b));
    });

    it("returns ids + owner for every matching review within one page", async () => {
        const result = await db.rpc("get_tabular_review_ids_overview", {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_project_id: null,
            p_scope: "in-project",
            p_search_term: "needle",
            p_limit: 1000,
            p_offset: 0,
        });

        expect(result.error).toBeNull();
        const rows = (result.data ?? []) as { id: string; user_id: string }[];
        expect(rows).toHaveLength(projectReviewIds.length);
        expect(new Set(rows.map((row) => row.id))).toEqual(
            new Set(projectReviewIds),
        );
        expect(rows.every((row) => row.user_id === ownerId)).toBe(true);
    });

    it("paginates the ids RPC deterministically without duplicates or gaps", async () => {
        const pageSize = 10;
        const collected: string[] = [];
        for (let offset = 0; offset < projectReviewIds.length; offset += pageSize) {
            const page = await db.rpc("get_tabular_review_ids_overview", {
                p_user_id: ownerId,
                p_user_email: ownerEmail,
                p_project_id: null,
                p_scope: "in-project",
                p_search_term: "needle",
                p_limit: pageSize,
                p_offset: offset,
            });
            expect(page.error).toBeNull();
            collected.push(
                ...(page.data ?? []).map((row: any) => row.id as string),
            );
        }

        expect(new Set(collected).size).toBe(projectReviewIds.length);
        expect([...collected].sort()).toEqual([...projectReviewIds].sort());
    });

    it("returns every matching row when the limit exceeds the result set", async () => {
        // The Postgres legacy 3-arg overload achieves "no effective limit"
        // for callers that omit pagination by defaulting p_limit to
        // 2147483647; the JS RPC shim has no function-overload distinction
        // (backend/src/routes/tabular.ts always sends an explicit p_limit
        // via parsePaginationQuery's DEFAULT_LIMIT), so the equivalent
        // check here is that a sufficiently large explicit limit returns
        // the full filtered set, not that omitting p_limit is unbounded.
        const result = await db.rpc("get_tabular_reviews_overview", {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_project_id: null,
            p_limit: 1000,
            p_offset: 0,
        });

        expect(result.error).toBeNull();
        const returnedIds = new Set(
            (result.data ?? []).map((row: any) => row.id as string),
        );
        for (const id of [...projectReviewIds, ...standaloneReviewIds])
            expect(returnedIds.has(id)).toBe(true);
    });

    it.each([
        ["omitted", undefined],
        ["explicitly null", null],
    ])(
        "falls back to the default page size when p_limit is %s",
        async (_label, limit) => {
            // Postgres reaches the default through
            // `greatest(coalesce(p_limit, 20), 1)`, so null and absent behave
            // identically there. Number(null) is 0, so a naive numeric guard
            // on this side would clamp to a 1-row page instead.
            const result = await db.rpc("get_tabular_reviews_overview", {
                p_user_id: ownerId,
                p_user_email: ownerEmail,
                p_project_id: null,
                p_limit: limit,
                p_offset: null,
            });

            expect(result.error).toBeNull();
            expect(result.data).toHaveLength(20);
        },
    );

    it("defaults to a 20-row page when p_limit/p_offset are omitted", async () => {
        // Mirrors pagination.ts's DEFAULT_LIMIT of 20, which is what
        // backend/src/routes/tabular.ts always ends up sending even when
        // the client omits ?limit= — so the RPC shim's own default must
        // match, not silently return everything.
        const result = await db.rpc("get_tabular_reviews_overview", {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_project_id: null,
        });

        expect(result.error).toBeNull();
        expect(result.data).toHaveLength(20);
    });
});
