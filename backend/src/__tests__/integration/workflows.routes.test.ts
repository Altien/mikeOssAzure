import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Hoisted mock fns we want to reconfigure per-test.
// ---------------------------------------------------------------------------
const { checkProjectAccess, deleteUserProjects } = vi.hoisted(() => ({
    checkProjectAccess: vi.fn(),
    deleteUserProjects: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Configurable Supabase stub — same shape as projects.routes.test.ts's, since
// both exercise the same `app` import (which loads every router).
// ---------------------------------------------------------------------------
type QueryResult = { data: unknown; error: unknown };

let supabaseState: {
    rpc: QueryResult;
    tables: Record<string, QueryResult>;
    inserts: { table: string; payload: unknown }[];
};

function resetSupabaseState() {
    supabaseState = {
        rpc: { data: [], error: null },
        tables: {},
        inserts: [],
    };
}
resetSupabaseState();

function resultForTable(table: string): QueryResult {
    return supabaseState.tables[table] ?? { data: null, error: null };
}

function makeQuery(table: string) {
    const q: Record<string, unknown> = {};
    const chain = [
        "select", "update", "delete", "upsert",
        "eq", "neq", "in", "is", "or", "not", "lt", "gt", "gte", "lte",
        "filter", "order", "limit", "range", "contains",
    ];
    for (const m of chain) q[m] = vi.fn(() => q);
    q.insert = vi.fn((payload: unknown) => {
        supabaseState.inserts.push({ table, payload });
        return q;
    });
    q.single = vi.fn(() => Promise.resolve(resultForTable(table)));
    q.maybeSingle = vi.fn(() => Promise.resolve(resultForTable(table)));
    q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(resultForTable(table)).then(resolve, reject);
    return q;
}

function mockSupabase() {
    return {
        from: vi.fn((table: string) => makeQuery(table)),
        rpc: vi.fn(() => Promise.resolve(supabaseState.rpc)),
        auth: {
            getUser: () =>
                Promise.resolve({ data: { user: { id: "u1" } }, error: null }),
        },
    };
}

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => mockSupabase()),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "u1@test.local";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

vi.mock("../../lib/access", () => ({
    checkProjectAccess: (...args: unknown[]) => checkProjectAccess(...args),
    ensureDocAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
    ensureReviewAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
    filterAccessibleDocumentIds: vi.fn(async (ids: string[]) => ids),
    listAccessibleProjectIds: vi.fn(async () => []),
}));

vi.mock("../../lib/userDataCleanup", () => ({
    deleteUserProjects: (...args: unknown[]) => deleteUserProjects(...args),
    deleteAllUserChats: vi.fn(async () => {}),
    deleteAllUserTabularReviews: vi.fn(async () => {}),
    deleteUserAccountData: vi.fn(async () => {}),
}));

vi.mock("../../lib/documentVersions", () => ({
    attachActiveVersionPaths: vi.fn(async () => {}),
    attachLatestVersionNumbers: vi.fn(async () => {}),
    contentSha256: vi.fn(() => "0".repeat(64)),
    loadActiveVersion: vi.fn(async () => null),
}));

import { app } from "../../app";
import { createServerSupabase } from "../../lib/supabase";

const AUTH = ["Authorization", "Bearer test"] as const;

function captureRpcArgs(): { args: unknown; name: string | undefined } {
    const captured: { args: unknown; name: string | undefined } = {
        args: undefined,
        name: undefined,
    };
    vi.mocked(createServerSupabase).mockImplementationOnce(() => {
        const db = mockSupabase();
        const originalRpc = db.rpc;
        db.rpc = vi.fn((name: string, args: unknown) => {
            captured.name = name;
            captured.args = args;
            return originalRpc(name, args as never);
        });
        return db as unknown as ReturnType<typeof createServerSupabase>;
    });
    return captured;
}

describe("workflows.routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetSupabaseState();
    });

    // ── GET /workflows (overview) ─────────────────────────────────────────
    describe("GET /workflows", () => {
        it("returns system workflows prepended to the RPC's rows when no pagination params are present", async () => {
            supabaseState.rpc = {
                data: [{ id: "w1", title: "My workflow" }],
                error: null,
            };

            const res = await request(app)
                .get("/workflows?type=assistant")
                .set(...AUTH);

            expect(res.status).toBe(200);
            // System workflows (static, non-uuid ids) come first, then the
            // DB row (mapped through withDatabaseWorkflow) — exact system
            // count isn't pinned here since it's a generated constant, just
            // that the DB row survived untouched.
            expect(res.body.at(-1)).toMatchObject({
                id: "w1",
                is_system: false,
                metadata: { title: "My workflow" },
            });
        });

        // Regression guard: the workflow picker modal, the chat slash-menu
        // picker, and UseWorkflowModal's own independent fetch all call
        // GET /workflows with no pagination params and need the exact
        // legacy response shape (system workflows included) back. If this
        // ever silently switched to the paginated RPC shape by default,
        // those callers would start seeing a truncated, system-workflow-free
        // list with no error.
        it("calls the legacy 3-arg RPC shape when no pagination params are present", async () => {
            const captured = captureRpcArgs();
            supabaseState.rpc = { data: [], error: null };

            await request(app).get("/workflows?type=tabular").set(...AUTH);

            expect(captured.name).toBe("get_workflows_overview");
            expect(captured.args).toEqual({
                p_user_id: "u1",
                p_user_email: "u1@test.local",
                p_type: "tabular",
            });
        });

        it("calls the paginated RPC shape with every filter parsed once any pagination param is present, and omits system workflows", async () => {
            const captured = captureRpcArgs();
            supabaseState.rpc = { data: [], error: null };

            const res = await request(app)
                .get(
                    "/workflows?limit=10&scope=owned&sort_key=name&sort_direction=asc" +
                        "&search=nda&practice=Litigation&language=English&jurisdiction=NSW",
                )
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual([]);
            expect(captured.name).toBe("get_workflows_overview");
            expect(captured.args).toEqual({
                p_user_id: "u1",
                p_user_email: "u1@test.local",
                p_type: null,
                p_scope: "owned",
                p_limit: 10,
                p_offset: 0,
                p_search_term: "nda",
                p_sort_key: "name",
                p_sort_direction: "asc",
                p_practice: "Litigation",
                p_language: "English",
                p_jurisdiction: "NSW",
            });
        });

        it("returns 500 with detail when the RPC errors", async () => {
            supabaseState.rpc = { data: null, error: { message: "boom" } };

            const res = await request(app).get("/workflows?type=assistant").set(...AUTH);

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("boom");
        });
    });

    // ── GET /workflows/system ──────────────────────────────────────────────
    describe("GET /workflows/system", () => {
        it("returns only system workflows, filtered by type, with no RPC call", async () => {
            // Deliberately does NOT touch createServerSupabase's mock at
            // all — this route makes no DB call whatsoever, so overriding
            // it here (even just to assert non-invocation) would leave a
            // queued mockImplementationOnce that the route never consumes,
            // shifting every later test's mock by one call. The fact that
            // this route resolves correctly using only the untouched
            // module-level createServerSupabase mock (never called) is
            // itself the proof no RPC/DB access happened.
            const res = await request(app)
                .get("/workflows/system?type=assistant")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
            expect(res.body.length).toBeGreaterThan(0);
            expect(res.body.every((w: { is_system: boolean; metadata: { type: string } }) =>
                w.is_system && w.metadata.type === "assistant",
            )).toBe(true);
            expect(createServerSupabase).not.toHaveBeenCalled();
        });
    });

    // ── GET /workflows/ids (select-all-matching support) ──────────────────
    describe("GET /workflows/ids", () => {
        it("pages through the RPC until an empty page is returned", async () => {
            const rpcMock = vi
                .fn()
                .mockResolvedValueOnce({
                    data: [{ id: "w1", user_id: "u1" }],
                    error: null,
                })
                .mockResolvedValueOnce({ data: [], error: null });
            vi.mocked(createServerSupabase).mockImplementationOnce(() => {
                const db = mockSupabase();
                db.rpc = rpcMock;
                return db as unknown as ReturnType<typeof createServerSupabase>;
            });

            const res = await request(app).get("/workflows/ids").set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual([{ id: "w1", user_id: "u1" }]);
            expect(rpcMock).toHaveBeenCalledTimes(2);
            expect(rpcMock.mock.calls[0][0]).toBe("get_workflow_ids_overview");
        });

        it("returns 500 with detail when the RPC errors", async () => {
            supabaseState.rpc = { data: null, error: { message: "boom" } };

            const res = await request(app).get("/workflows/ids").set(...AUTH);

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("boom");
        });
    });
});
