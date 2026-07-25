import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const { runLLMStream, checkProjectAccess } = vi.hoisted(() => ({
    runLLMStream: vi.fn(),
    checkProjectAccess: vi.fn(),
}));

function makeQuery() {
    const result = {
        data: { id: "chat-1", title: null, project_id: "p1" },
        error: null,
    };
    const q: Record<string, unknown> = {};
    const chain = [
        "select", "insert", "update", "delete", "upsert",
        "eq", "neq", "in", "is", "or", "lt", "gt", "gte", "lte",
        "filter", "order", "limit", "range", "contains",
    ];
    for (const m of chain) q[m] = vi.fn(() => q);
    q.single = vi.fn(() => Promise.resolve(result));
    q.maybeSingle = vi.fn(() => Promise.resolve(result));
    q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject);
    return q;
}

function mockSupabase() {
    return {
        from: vi.fn(() => makeQuery()),
        rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
        auth: {
            getUser: () =>
                Promise.resolve({ data: { user: { id: "u1" } }, error: null }),
        },
    };
}

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => mockSupabase()),
    getUserIdFromRequest: vi.fn(async () => "u1"),
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

vi.mock("../../lib/chat", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../lib/chat")>();
    return {
        ...actual,
        buildProjectDocContext: vi.fn(async () => ({
            docIndex: {},
            docStore: new Map(),
            folderPaths: new Map(),
        })),
        enrichWithPriorEvents: vi.fn(async (messages: unknown) => messages),
        buildWorkflowStore: vi.fn(async () => new Map()),
        buildMessages: vi.fn(() => []),
        runLLMStream: (...args: unknown[]) => runLLMStream(...args),
    };
});

vi.mock("../../lib/userSettings", () => ({
    getUserModelSettings: vi.fn(async () => ({
        legal_research_us: false,
        title_model: "test-model",
        tabular_model: "test-model",
        api_keys: {},
    })),
    getUserApiKeys: vi.fn(async () => ({})),
}));

vi.mock("../../lib/access", () => ({
    checkProjectAccess: (...args: unknown[]) => checkProjectAccess(...args),
    ensureDocAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
    ensureReviewAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
    filterAccessibleDocumentIds: vi.fn(async (ids: string[]) => ids),
    listAccessibleProjectIds: vi.fn(async () => []),
}));

import { app } from "../../app";

const VALID_BODY = { messages: [{ role: "user", content: "hello" }] };

describe("POST /projects/:projectId/chat", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        runLLMStream.mockResolvedValue({
            fullText: "",
            events: [],
            citations: [],
        });
        checkProjectAccess.mockResolvedValue({
            ok: true,
            isOwner: true,
            project: { id: "p1", user_id: "u1", shared_with: null },
        });
    });

    it("returns 404 and never streams when project access is denied", async () => {
        checkProjectAccess.mockResolvedValue({ ok: false });

        const res = await request(app)
            .post("/projects/p1/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        expect(res.status).toBe(404);
        expect(res.body.detail).toBe("Project not found");
        // The guard fires before any LLM stream.
        expect(runLLMStream).not.toHaveBeenCalled();
    });

    it("streams SSE on the happy path with project access granted", async () => {
        const res = await request(app)
            .post("/projects/p1/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toContain("text/event-stream");
        expect(res.text).toContain('"type":"chat_id"');
        expect(runLLMStream).toHaveBeenCalledTimes(1);
    });

    it("surfaces a stream failure as an in-stream error event, not an HTTP error", async () => {
        runLLMStream.mockRejectedValue(new Error("upstream LLM failure"));

        const res = await request(app)
            .post("/projects/p1/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        expect(res.status).toBe(200);
        expect(res.text).toContain('"type":"error"');
        expect(res.text).toContain("[DONE]");
    });
});
