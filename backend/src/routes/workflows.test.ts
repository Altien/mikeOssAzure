import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, type DbCall, type DbResult } from "../test/helpers/fakeDb";

// Route tests for upstream's metadata-shaped workflows router (204d2d53,
// adopted verbatim in OSS-6 C7). Upstream's own tests are Supabase-stubbed
// integration tests; these use dev's supertest + fakeDb pattern. Access is
// app-layer (owner / workflow_shares), so the fake answers per table.

const {
    validateSupabaseTokenMock,
    upsertUserProfileMock,
    createServerSupabaseMock,
    findMissingUserEmailsMock,
} = vi.hoisted(() => ({
    validateSupabaseTokenMock: vi.fn(),
    upsertUserProfileMock: vi.fn(),
    createServerSupabaseMock: vi.fn(),
    findMissingUserEmailsMock: vi.fn(),
}));

vi.mock("../lib/auth/providers/supabase.js", () => ({
    validateSupabaseToken: validateSupabaseTokenMock,
}));
vi.mock("../lib/userSettings.js", () => ({
    upsertUserProfile: upsertUserProfileMock,
}));
vi.mock("../lib/supabase", () => ({
    createServerSupabase: createServerSupabaseMock,
}));
vi.mock("../lib/userLookup", () => ({
    findMissingUserEmails: findMissingUserEmailsMock,
}));

const TOUCHED_ENV = ["AUTH_PROVIDER", "WORKFLOW_CONTRIBUTIONS_ENABLED"] as const;
const envSnapshot = {} as Record<string, string | undefined>;

const USER_ID = "user-1";
const USER_EMAIL = "owner@example.com";

// The contributions flag is read once at module load (upstream verbatim), so
// every test imports a fresh router with the env it needs.
async function makeApp(contributions = false) {
    if (contributions) process.env.WORKFLOW_CONTRIBUTIONS_ENABLED = "true";
    else delete process.env.WORKFLOW_CONTRIBUTIONS_ENABLED;
    vi.resetModules();
    const { workflowsRouter } = await import("./workflows");
    const { quickActionsRouter } = await import("./quickActions");
    const app = express();
    app.use(express.json());
    app.use("/api/workflows", workflowsRouter);
    app.use("/api/quick-actions", quickActionsRouter);
    return app;
}

function useDb(respond: (call: DbCall) => DbResult) {
    // #309 installs defaults before listing; isolate this RPC from overview data.
    const fake = makeFakeDb((call) => call.table === "install_missing_default_workflows"
        ? { data: 0 } : respond(call));
    createServerSupabaseMock.mockReturnValue(fake.db);
    return fake;
}

const OWNED_ROW = {
    id: "wf-owned",
    user_id: USER_ID,
    title: "Owned review",
    type: "tabular",
    prompt_md: null,
    columns_config: [{ index: 0, name: "Parties", prompt: "Who?" }],
    language: "English",
    practice: "Litigation",
    jurisdictions: ["England and Wales"],
    created_at: "2026-09-01T00:00:00.000Z",
    shared_by_name: null,
    allow_edit: true,
    is_owner: true,
};

const SHARED_ROW = {
    id: "wf-shared",
    user_id: "someone-else",
    title: "Shared assistant",
    type: "assistant",
    prompt_md: "---\nname: shared-skill\n---\nDo the thing.",
    columns_config: null,
    language: null,
    practice: null,
    jurisdictions: null,
    created_at: "2026-09-02T00:00:00.000Z",
    shared_by_name: "Sharer",
    allow_edit: false,
    is_owner: false,
};

beforeEach(() => {
    for (const k of TOUCHED_ENV) envSnapshot[k] = process.env[k];
    process.env.AUTH_PROVIDER = "supabase";
    validateSupabaseTokenMock.mockReset().mockResolvedValue({
        ok: true,
        principal: {
            userId: USER_ID,
            email: USER_EMAIL,
            groups: [],
            roles: [],
            provider: "supabase",
        },
    });
    upsertUserProfileMock.mockReset().mockResolvedValue(undefined);
    createServerSupabaseMock.mockReset();
    findMissingUserEmailsMock.mockReset().mockResolvedValue([]);
    vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
    for (const k of TOUCHED_ENV) {
        if (envSnapshot[k] === undefined) delete process.env[k];
        else process.env[k] = envSnapshot[k];
    }
    vi.restoreAllMocks();
});

const auth = { Authorization: "Bearer ok" };

// #309: private PostgREST has no identity RLS; keep route-level revocation checks.
describe("quick action access", () => {
    it("omits revoked workflow titles and scopes quick actions to the caller", async () => {
        const fake = useDb((call) => {
            if (call.table === "quick_actions") return { data: [
                { id: "qa-owned", workflow_id: "wf-owned", user_id: USER_ID },
                { id: "qa-revoked", workflow_id: "wf-revoked", user_id: USER_ID },
                { id: "qa-shared", workflow_id: "wf-shared", user_id: USER_ID },
            ] };
            if (call.table === "workflows") return { data: [{ ...OWNED_ROW, type: "assistant" }, SHARED_ROW,
                { id: "wf-revoked", user_id: "other", title: "Private title" },
            ] };
            if (call.table === "workflow_shares") return { data: [{ workflow_id: "wf-shared" }] };
            return { data: [] };
        });
        const res = await request(await makeApp()).get("/api/quick-actions").set(auth);
        expect(res.status).toBe(200);
        expect(res.body.map((action: { id: string }) => action.id)).toEqual(["qa-owned", "qa-shared"]);
        expect(fake.callsFor("quick_actions")[0].filters).toContainEqual(["eq", "user_id", USER_ID]);
        expect(fake.callsFor("workflow_shares")[0].filters).toContainEqual(["eq", "shared_with_email", USER_EMAIL]);
        expect(JSON.stringify(res.body)).not.toContain("Private title");
    });

    it("returns 404 after updating a quick action whose workflow share was revoked", async () => {
        const fake = useDb((call) => {
            if (call.table === "quick_actions") return { data: { id: "qa-revoked", workflow_id: "wf-revoked", user_id: USER_ID } };
            if (call.table === "workflows") return { data: [{ id: "wf-revoked", user_id: "other", title: "Private title" }] };
            return { data: [] };
        });
        const res = await request(await makeApp()).patch("/api/quick-actions/qa-revoked").set(auth).send({ enabled: false });
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ detail: "Quick action not found" });
        expect(fake.callsFor("quick_actions", "update")[0].filters).toEqual([
            ["eq", "id", "qa-revoked"], ["eq", "user_id", USER_ID],
        ]);
    });

    it("rejects creating an action for an unshared foreign workflow", async () => {
        const fake = useDb((call) => call.table === "workflows"
            ? { data: [SHARED_ROW] } : { data: [] });
        const res = await request(await makeApp()).post("/api/quick-actions").set(auth).send({ workflow_id: SHARED_ROW.id });
        expect(res.status).toBe(404);
        expect(fake.callsFor("quick_actions", "insert")).toHaveLength(0);
    });
});

// ── GET /workflows ──────────────────────────────────────────────────────

describe("GET /workflows", () => {
    it("requires authentication", async () => {
        const res = await request(await makeApp()).get("/api/workflows");
        expect(res.status).toBe(401);
    });

    it("lists installed owned and shared workflows in metadata shape", async () => {
        const fake = useDb((call) =>
            call.op === "rpc"
                ? { data: [OWNED_ROW, SHARED_ROW] }
                : { data: [] },
        );

        const res = await request(await makeApp())
            .get("/api/workflows")
            .set(auth);

        expect(res.status).toBe(200);
        // #309 defaults are editable DB copies, never prepended static rows.
        expect(res.body).toHaveLength(2);
        const [owned, shared] = res.body;
        expect(owned).toMatchObject({
            id: "wf-owned",
            user_id: USER_ID,
            is_system: false,
            skill_md: null,
            columns_config: OWNED_ROW.columns_config,
            allow_edit: true,
            is_owner: true,
            metadata: {
                name: null,
                title: "Owned review",
                description: null,
                type: "tabular",
                language: "English",
                practice: "Litigation",
                jurisdictions: ["England and Wales"],
                contributors: [
                    { name: "Mike", organisation: null, role: null, linkedin: null },
                ],
            },
        });
        // The flat columns are folded into metadata, not echoed.
        expect(owned).not.toHaveProperty("title");
        expect(owned).not.toHaveProperty("prompt_md");

        expect(shared).toMatchObject({
            id: "wf-shared",
            skill_md: SHARED_ROW.prompt_md,
            shared_by_name: "Sharer",
            allow_edit: false,
            is_owner: false,
            metadata: {
                name: "shared-skill",
                type: "assistant",
                // Upstream defaults for rows without metadata columns.
                language: "English",
                practice: "General Transactions",
                jurisdictions: ["General"],
            },
        });

        // Access filtering is the overview RPC's job, scoped to the caller.
        const rpc = fake.calls.find((c) => c.table === "get_workflows_overview");
        expect(rpc).toMatchObject({
            table: "get_workflows_overview",
            payload: { p_user_id: USER_ID, p_user_email: USER_EMAIL, p_type: null },
        });
    });

    it("forwards the type to the owned/shared overview RPC", async () => {
        const fake = useDb((call) =>
            call.op === "rpc" ? { data: [] } : { data: [] },
        );

        const res = await request(await makeApp())
            .get("/api/workflows?type=tabular")
            .set(auth);

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
        expect(fake.calls.find((c) => c.table === "get_workflows_overview")?.payload).toMatchObject({
            p_type: "tabular",
        });
    });

    it("marks only the caller's installed default workflow rows", async () => {
        const defaultId = OWNED_ROW.id;
        useDb((call) =>
            call.op === "rpc"
                ? { data: [OWNED_ROW, SHARED_ROW] }
                : call.table === "default_workflow_installations"
                  ? { data: [{ workflow_id: defaultId, default_key: "proofread" }] } : { data: [] },
        );

        const res = await request(await makeApp())
            .get("/api/workflows")
            .set(auth);

        expect(res.body).toHaveLength(2);
        expect(res.body[0]).toMatchObject({ id: defaultId, is_default: true });
        expect(res.body[1]).toMatchObject({ id: SHARED_ROW.id, is_default: false });
    });

    it("returns 500 when the overview RPC errors", async () => {
        useDb((call) =>
            call.op === "rpc" ? { data: null, error: { message: "rpc down" } } : {},
        );

        const res = await request(await makeApp())
            .get("/api/workflows")
            .set(auth);

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ code: "internal_error", detail: "Something went wrong. Please try again." });
    });

    it("turns a thrown handler error into a 500 via the router error handler", async () => {
        createServerSupabaseMock.mockImplementation(() => {
            throw new Error("db unavailable");
        });
        vi.spyOn(console, "error").mockImplementation(() => {});

        const res = await request(await makeApp())
            .get("/api/workflows")
            .set(auth);

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ detail: "Failed to process workflow request" });
    });
});

// ── hidden workflows ────────────────────────────────────────────────────

describe("hidden workflows", () => {
    it("GET /workflows/hidden returns the caller's hidden ids", async () => {
        const fake = useDb((call) =>
            call.table === "hidden_workflows"
                ? { data: [{ workflow_id: "a" }, { workflow_id: "b" }] }
                : {},
        );

        const res = await request(await makeApp())
            .get("/api/workflows/hidden")
            .set(auth);

        expect(res.status).toBe(200);
        expect(res.body).toEqual(["a", "b"]);
        expect(fake.callsFor("hidden_workflows")[0].filters).toContainEqual([
            "eq",
            "user_id",
            USER_ID,
        ]);
    });

    it("POST /workflows/hidden upserts; 400 without workflow_id", async () => {
        const fake = useDb(() => ({}));
        const app = await makeApp();

        const ok = await request(app)
            .post("/api/workflows/hidden")
            .set(auth)
            .send({ workflow_id: "wf-1" });
        expect(ok.status).toBe(204);
        expect(fake.callsFor("hidden_workflows", "upsert")[0].payload).toEqual({
            user_id: USER_ID,
            workflow_id: "wf-1",
        });

        const bad = await request(app)
            .post("/api/workflows/hidden")
            .set(auth)
            .send({});
        expect(bad.status).toBe(400);
    });

    it("DELETE /workflows/hidden/:id unhides for the caller only", async () => {
        const fake = useDb(() => ({}));

        const res = await request(await makeApp())
            .delete("/api/workflows/hidden/wf-1")
            .set(auth);

        expect(res.status).toBe(204);
        const del = fake.callsFor("hidden_workflows", "delete")[0];
        expect(del.filters).toEqual([
            ["eq", "user_id", USER_ID],
            ["eq", "workflow_id", "wf-1"],
        ]);
    });
});

// ── create / update ─────────────────────────────────────────────────────

describe("POST /workflows", () => {
    it("creates from metadata + skill_md and answers in metadata shape", async () => {
        const fake = useDb((call) =>
            call.op === "insert"
                ? { data: { id: "wf-new", created_at: "now", ...(call.payload as object) } }
                : {},
        );

        const res = await request(await makeApp())
            .post("/api/workflows")
            .set(auth)
            .send({
                metadata: {
                    title: "  New assistant  ",
                    type: "assistant",
                    language: " French ",
                    jurisdictions: ["France", "France", " "],
                },
                skill_md: "---\nname: new-skill\n---\nBody",
            });

        expect(res.status).toBe(201);
        expect(fake.callsFor("workflows", "insert")[0].payload).toEqual({
            user_id: USER_ID,
            title: "New assistant",
            type: "assistant",
            prompt_md: "---\nname: new-skill\n---\nBody",
            columns_config: null,
            language: "French",
            practice: "General Transactions",
            jurisdictions: ["France"],
        });
        expect(res.body).toMatchObject({
            id: "wf-new",
            skill_md: "---\nname: new-skill\n---\nBody",
            is_system: false,
            metadata: {
                name: "new-skill",
                title: "New assistant",
                type: "assistant",
                language: "French",
                jurisdictions: ["France"],
            },
        });
    });

    it("rejects a missing title or an unknown type", async () => {
        useDb(() => ({}));
        const app = await makeApp();

        const noTitle = await request(app)
            .post("/api/workflows")
            .set(auth)
            .send({ metadata: { type: "assistant" } });
        expect(noTitle.status).toBe(400);
        expect(noTitle.body.detail).toBe("metadata.title is required");

        const badType = await request(app)
            .post("/api/workflows")
            .set(auth)
            .send({ metadata: { title: "X", type: "flat" } });
        expect(badType.status).toBe(400);
        expect(badType.body.detail).toBe(
            "metadata.type must be 'assistant' or 'tabular'",
        );
    });
});

describe("PATCH /workflows/:id — app-layer access", () => {
    function accessDb(opts: {
        row: Record<string, unknown>;
        share?: { allow_edit: boolean } | null;
    }) {
        return useDb((call) => {
            if (call.table === "workflows" && call.op === "select") {
                return { data: opts.row };
            }
            if (call.table === "workflow_shares") {
                return { data: opts.share ?? null };
            }
            if (call.table === "workflows" && call.op === "update") {
                return { data: { ...opts.row, ...(call.payload as object) } };
            }
            return {};
        });
    }

    it("the owner updates metadata and skill_md", async () => {
        const fake = accessDb({ row: OWNED_ROW });

        const res = await request(await makeApp())
            .patch("/api/workflows/wf-owned")
            .set(auth)
            .send({
                metadata: { title: "Renamed", practice: "Tax", jurisdictions: [] },
                skill_md: "new body",
            });

        expect(res.status).toBe(200);
        expect(fake.callsFor("workflows", "update")[0].payload).toEqual({
            title: "Renamed",
            prompt_md: "new body",
            practice: "Tax",
            jurisdictions: null,
        });
        expect(res.body).toMatchObject({
            allow_edit: true,
            is_owner: true,
            skill_md: "new body",
            metadata: { title: "Renamed", practice: "Tax" },
        });
        // Owner short-circuits: no share lookup.
        expect(fake.callsFor("workflow_shares")).toHaveLength(0);
    });

    it("a shared-with-edit user can update", async () => {
        const fake = accessDb({
            row: { ...OWNED_ROW, user_id: "someone-else" },
            share: { allow_edit: true },
        });

        const res = await request(await makeApp())
            .patch("/api/workflows/wf-owned")
            .set(auth)
            .send({ metadata: { title: "Edited by collaborator" } });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ allow_edit: true, is_owner: false });
        expect(fake.callsFor("workflow_shares")[0].filters).toContainEqual([
            "eq",
            "shared_with_email",
            USER_EMAIL,
        ]);
    });

    it("a view-only share gets 404 and nothing is written", async () => {
        const fake = accessDb({
            row: { ...OWNED_ROW, user_id: "someone-else" },
            share: { allow_edit: false },
        });

        const res = await request(await makeApp())
            .patch("/api/workflows/wf-owned")
            .set(auth)
            .send({ metadata: { title: "Nope" } });

        expect(res.status).toBe(404);
        expect(res.body.detail).toBe("Workflow not found or not editable");
        expect(fake.callsFor("workflows", "update")).toHaveLength(0);
    });

    it("an unrelated user (no share) gets 404", async () => {
        const fake = accessDb({
            row: { ...OWNED_ROW, user_id: "someone-else" },
            share: null,
        });

        const res = await request(await makeApp())
            .put("/api/workflows/wf-owned")
            .set(auth)
            .send({ metadata: { title: "Nope" } });

        expect(res.status).toBe(404);
        expect(fake.callsFor("workflows", "update")).toHaveLength(0);
    });
});

// ── GET /workflows/:id ──────────────────────────────────────────────────

describe("GET /workflows/:id", () => {
    it("serves a system workflow from the published database catalogue", async () => {
        const fake = useDb((call) => call.table === "mike_workflows"
            ? { data: { workflow_key: "proofread", title: "Proofread", type: "assistant", prompt_md: "Review the text", created_at: "2026-09-01", contributors: [], jurisdictions: [], content_hash: "hash" } }
            : { data: [] });

        const res = await request(await makeApp())
            .get("/api/workflows/builtin-proofread")
            .set(auth);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            id: "builtin-proofread",
            metadata: { title: "Proofread" },
            allow_edit: false,
            is_owner: false,
        });
        expect(fake.callsFor("mike_workflows")[0].filters).toContainEqual(["eq", "workflow_key", "proofread"]);
    });

    it("the owner sees the latest open-source submission", async () => {
        const submission = {
            id: "sub-1",
            status: "pending",
            submitted_at: "2026-09-10T00:00:00.000Z",
            updated_at: "2026-09-10T00:00:00.000Z",
            reviewed_at: null,
        };
        useDb((call) => {
            if (call.table === "workflows") return { data: OWNED_ROW };
            if (call.table === "workflow_open_source_submissions")
                return { data: submission };
            return {};
        });

        const res = await request(await makeApp())
            .get("/api/workflows/wf-owned")
            .set(auth);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            id: "wf-owned",
            is_owner: true,
            open_source_submission: submission,
        });
    });

    it("a view-only share can read (no submission info); strangers get 404", async () => {
        const row = { ...SHARED_ROW };
        let share: { allow_edit: boolean } | null = { allow_edit: false };
        useDb((call) => {
            if (call.table === "workflows") return { data: row };
            if (call.table === "workflow_shares") return { data: share };
            return {};
        });
        const app = await makeApp();

        const shared = await request(app).get("/api/workflows/wf-shared").set(auth);
        expect(shared.status).toBe(200);
        expect(shared.body).toMatchObject({
            allow_edit: false,
            is_owner: false,
            open_source_submission: null,
        });

        share = null;
        const stranger = await request(app).get("/api/workflows/wf-shared").set(auth);
        expect(stranger.status).toBe(404);
    });
});

// ── sharing ─────────────────────────────────────────────────────────────

describe("POST /workflows/:id/share", () => {
    it("upserts normalised shares for existing users", async () => {
        const fake = useDb((call) =>
            call.table === "workflows" ? { data: { id: "wf-owned" } } : {},
        );

        const res = await request(await makeApp())
            .post("/api/workflows/wf-owned/share")
            .set(auth)
            .send({ emails: [" Alice@Example.com ", "alice@example.com"], allow_edit: true });

        expect(res.status).toBe(204);
        expect(fake.callsFor("workflow_shares", "upsert")[0].payload).toEqual([
            {
                workflow_id: "wf-owned",
                shared_by_user_id: USER_ID,
                shared_with_email: "alice@example.com",
                allow_edit: true,
            },
        ]);
    });

    it("rejects sharing with yourself or with a non-user", async () => {
        useDb((call) =>
            call.table === "workflows" ? { data: { id: "wf-owned" } } : {},
        );
        const app = await makeApp();

        const self = await request(app)
            .post("/api/workflows/wf-owned/share")
            .set(auth)
            .send({ emails: [USER_EMAIL] });
        expect(self.status).toBe(400);

        findMissingUserEmailsMock.mockResolvedValueOnce(["ghost@example.com"]);
        const ghost = await request(app)
            .post("/api/workflows/wf-owned/share")
            .set(auth)
            .send({ emails: ["ghost@example.com"] });
        expect(ghost.status).toBe(400);
        expect(ghost.body.detail).toBe(
            "ghost@example.com does not belong to a Mike user.",
        );
    });
});

// ── open-source contributions (flag) ────────────────────────────────────

describe("POST /workflows/:id/open-source", () => {
    it("is rejected with 404 when WORKFLOW_CONTRIBUTIONS_ENABLED is off", async () => {
        const fake = useDb(() => ({ data: OWNED_ROW }));

        const res = await request(await makeApp(false))
            .post("/api/workflows/wf-owned/open-source")
            .set(auth)
            .send({ contributor_mode: "anonymous" });

        expect(res.status).toBe(404);
        expect(res.body.detail).toBe("Workflow contributions are disabled");
        expect(fake.calls).toHaveLength(0);
    });

    function contributionDb(opts: {
        workflow?: Record<string, unknown> | null;
        pending?: Record<string, unknown> | null;
    }) {
        const summary = {
            id: "sub-1",
            status: "pending",
            submitted_at: "t0",
            updated_at: "t1",
            reviewed_at: null,
        };
        return useDb((call) => {
            if (call.table === "workflows")
                return { data: opts.workflow === undefined ? OWNED_ROW : opts.workflow };
            if (call.table === "user_profiles")
                return { data: { display_name: "Owner Name" } };
            if (call.table === "workflow_open_source_submissions") {
                if (call.op === "select") return { data: opts.pending ?? null };
                return { data: summary };
            }
            return {};
        });
    }

    it("flag on: creates a pending submission with a metadata snapshot (201)", async () => {
        const fake = contributionDb({});

        const res = await request(await makeApp(true))
            .post("/api/workflows/wf-owned/open-source")
            .set(auth)
            .send({ contributor_mode: "named" });

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ id: "sub-1", status: "pending", mode: "created" });
        const insert = fake.callsFor("workflow_open_source_submissions", "insert")[0];
        expect(insert.payload).toMatchObject({
            workflow_id: "wf-owned",
            submitted_by_user_id: USER_ID,
            submitter_email: USER_EMAIL,
            submitter_name: "Owner Name",
            contributor_mode: "named",
            status: "pending",
            snapshot: {
                workflow_id: "wf-owned",
                skill_md: null,
                columns_config: OWNED_ROW.columns_config,
                contributor_mode: "named",
                metadata: {
                    title: "Owned review",
                    type: "tabular",
                    contributors: [
                        {
                            name: "Owner Name",
                            organisation: null,
                            role: null,
                            linkedin: null,
                        },
                    ],
                },
            },
        });
        // Only the owner's own workflow is eligible.
        expect(fake.callsFor("workflows")[0].filters).toContainEqual([
            "eq",
            "user_id",
            USER_ID,
        ]);
    });

    it("flag on: a pending duplicate is updated instead of stacking (200, mode updated)", async () => {
        const fake = contributionDb({ pending: { id: "sub-1", status: "pending" } });

        const res = await request(await makeApp(true))
            .post("/api/workflows/wf-owned/open-source")
            .set(auth)
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.mode).toBe("updated");
        expect(fake.callsFor("workflow_open_source_submissions", "insert")).toHaveLength(0);
        const update = fake.callsFor("workflow_open_source_submissions", "update")[0];
        expect(update.filters).toContainEqual(["eq", "id", "sub-1"]);
        // Anonymous by default: no submitter name, the "Mike" contributor.
        expect(update.payload).toMatchObject({
            submitter_name: null,
            contributor_mode: "anonymous",
            snapshot: {
                metadata: {
                    contributors: [
                        { name: "Mike", organisation: null, role: null, linkedin: null },
                    ],
                },
            },
        });
    });

    it("flag on: 404 for a workflow the caller does not own; 400 for an empty one", async () => {
        contributionDb({ workflow: null });
        const app = await makeApp(true);
        const missing = await request(app)
            .post("/api/workflows/wf-other/open-source")
            .set(auth)
            .send({});
        expect(missing.status).toBe(404);

        contributionDb({ workflow: { ...SHARED_ROW, user_id: USER_ID, prompt_md: "  " } });
        const empty = await request(app)
            .post("/api/workflows/wf-shared/open-source")
            .set(auth)
            .send({});
        expect(empty.status).toBe(400);
        expect(empty.body.detail).toMatch(/need instructions/);
    });
});
