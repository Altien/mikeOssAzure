import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.SUPABASE_TEST_URL;
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const maybeDescribe = url && serviceKey ? describe : describe.skip;

maybeDescribe("Supabase tabular-review pagination", () => {
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
    let admin: SupabaseClient;

    beforeAll(async () => {
        admin = createClient(url!, serviceKey!, {
            auth: { persistSession: false, autoRefreshToken: false },
        });

        const project = await admin.from("projects").insert({
            id: projectId,
            user_id: ownerId,
            name: "Pagination integration project",
        });
        if (project.error) throw project.error;

        const projectReviews = await admin.from("tabular_reviews").insert(
            projectReviewIds.map((id, index) => ({
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
            })),
        );
        if (projectReviews.error) throw projectReviews.error;

        const standaloneReviews = await admin.from("tabular_reviews").insert(
            standaloneReviewIds.map((id) => ({
                id,
                user_id: ownerId,
                title: "Standalone Needle",
                columns_config: [],
                document_ids: [],
                created_at: tiedCreatedAt,
                updated_at: tiedCreatedAt,
            })),
        );
        if (standaloneReviews.error) throw standaloneReviews.error;
    });

    afterAll(async () => {
        if (!admin) return;
        await admin
            .from("tabular_reviews")
            .delete()
            .in("id", standaloneReviewIds);
        await admin.from("projects").delete().eq("id", projectId);
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
        const firstPage = await admin.rpc("get_tabular_reviews_overview", {
            ...commonArgs,
            p_limit: 20,
            p_offset: 0,
        });
        const secondPage = await admin.rpc("get_tabular_reviews_overview", {
            ...commonArgs,
            p_limit: 20,
            p_offset: 20,
        });

        expect(firstPage.error).toBeNull();
        expect(secondPage.error).toBeNull();
        expect(firstPage.data).toHaveLength(20);
        expect(secondPage.data).toHaveLength(5);

        const firstIds = (firstPage.data ?? []).map((row) => row.id);
        const secondIds = (secondPage.data ?? []).map((row) => row.id);
        expect(new Set([...firstIds, ...secondIds]).size).toBe(25);
        expect([...firstIds, ...secondIds]).toEqual(
            [...projectReviewIds].sort(),
        );
    });

    it("applies scope and search before limiting rows", async () => {
        const result = await admin.rpc("get_tabular_reviews_overview", {
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
            (result.data ?? []).every((row) => row.project_id === null),
        ).toBe(true);
    });

    it("sorts the complete filtered set before pagination", async () => {
        const result = await admin.rpc("get_tabular_reviews_overview", {
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
            (row) =>
                (row.columns_config as unknown[] | null | undefined)?.length ??
                0,
        );
        expect(columnCounts).toEqual([...columnCounts].sort((a, b) => a - b));
    });

    it("keeps the legacy three-argument RPC callable", async () => {
        const result = await admin.rpc("get_tabular_reviews_overview", {
            p_user_id: ownerId,
            p_user_email: ownerEmail,
            p_project_id: null,
        });

        expect(result.error).toBeNull();
        const returnedIds = new Set(
            (result.data ?? []).map((row) => row.id as string),
        );
        for (const id of [...projectReviewIds, ...standaloneReviewIds])
            expect(returnedIds.has(id)).toBe(true);
    });
});
