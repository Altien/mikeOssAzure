import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, type DbCall } from "../test/helpers/fakeDb";

const {
    validateSupabaseTokenMock,
    upsertUserProfileMock,
    getUserModelSettingsMock,
    createServerSupabaseMock,
    downloadFileMock,
    completeTextMock,
    streamChatWithToolsMock,
    filterAccessibleDocumentIdsMock,
} = vi.hoisted(() => ({
    validateSupabaseTokenMock: vi.fn(),
    upsertUserProfileMock: vi.fn(),
    getUserModelSettingsMock: vi.fn(),
    createServerSupabaseMock: vi.fn(),
    downloadFileMock: vi.fn(),
    completeTextMock: vi.fn(),
    streamChatWithToolsMock: vi.fn(),
    filterAccessibleDocumentIdsMock: vi.fn(),
}));

vi.mock("../lib/auth/providers/supabase.js", () => ({
    validateSupabaseToken: validateSupabaseTokenMock,
}));
vi.mock("../lib/userSettings.js", () => ({
    upsertUserProfile: upsertUserProfileMock,
    getUserModelSettings: getUserModelSettingsMock,
}));
vi.mock("../lib/supabase", () => ({
    createServerSupabase: createServerSupabaseMock,
}));
vi.mock("../lib/storage", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../lib/storage")>()),
    downloadFile: downloadFileMock,
}));
vi.mock("../lib/documentVersions", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../lib/documentVersions")>()),
    attachActiveVersionPaths: vi.fn(async () => undefined),
}));
vi.mock("../lib/llm", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../lib/llm")>()),
    completeText: completeTextMock,
    streamChatWithTools: streamChatWithToolsMock,
}));
vi.mock("../lib/access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../lib/access")>()),
    ensureReviewAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
    filterAccessibleDocumentIds: filterAccessibleDocumentIdsMock,
}));

import { tabularRouter } from "./tabular";

const ORIGINAL_AUTH_PROVIDER = process.env.AUTH_PROVIDER;

// One folder row whose sources include a document the caller cannot read,
// and one plain document row the caller can read.
const REVIEW = {
    id: "review-1",
    updated_at: "2026-08-22T10:00:00.000Z",
    user_id: "user-1",
    project_id: null,
    shared_with: [],
    document_ids: ["doc-a", "doc-foreign"],
    document_grouping: "folder",
    columns_config: [{ index: 0, name: "Parties", prompt: "Who are the parties?" }],
};
const ROWS = [
    {
        id: "row-folder",
        review_id: "review-1",
        label: "Contracts",
        row_type: "folder",
        folder_id: "folder-1",
        library_folder_id: null,
        document_id: null,
        sort_index: 0,
    },
    {
        id: "row-doc",
        review_id: "review-1",
        label: "a.pdf",
        row_type: "document",
        folder_id: null,
        library_folder_id: null,
        document_id: "doc-a",
        sort_index: 1,
    },
];
const ROW_SOURCES = [
    { row_id: "row-folder", document_id: "doc-a" },
    { row_id: "row-folder", document_id: "doc-foreign" },
    { row_id: "row-doc", document_id: "doc-a" },
];

function respond(call: DbCall) {
    if (call.op === "rpc") {
        return {
            data: call.table === "begin_tabular_review_generation" ? "started" : true,
            error: null,
        };
    }
    if (call.op !== "select") return { data: [], error: null };
    switch (call.table) {
        case "tabular_reviews":
            return { data: [REVIEW], error: null };
        case "tabular_review_rows":
            return { data: ROWS, error: null };
        case "tabular_review_row_sources":
            return { data: ROW_SOURCES, error: null };
        case "documents":
            return {
                data: [{ id: "doc-a", current_version_id: null }],
                error: null,
            };
        default:
            return { data: [], error: null };
    }
}

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/tabular-review", tabularRouter);
    return app;
}

beforeEach(() => {
    process.env.AUTH_PROVIDER = "supabase";
    validateSupabaseTokenMock.mockReset().mockResolvedValue({
        ok: true,
        principal: {
            userId: "user-1",
            email: "user@example.com",
            groups: [],
            roles: [],
            provider: "supabase",
        },
    });
    upsertUserProfileMock.mockReset().mockResolvedValue(undefined);
    getUserModelSettingsMock.mockReset().mockResolvedValue({
        tabular_model: "claude-sonnet-4-5",
        fast_model: "claude-sonnet-4-5",
        api_keys: { claude: "sk-test" },
    });
    createServerSupabaseMock.mockReset();
    downloadFileMock.mockReset().mockResolvedValue(null);
    completeTextMock
        .mockReset()
        .mockResolvedValue(
            '{"summary":"Acme","flag":"green","reasoning":"named on page 1"}',
        );
    streamChatWithToolsMock.mockReset();
    filterAccessibleDocumentIdsMock
        .mockReset()
        .mockImplementation(async (ids: string[]) =>
            ids.filter((id) => id !== "doc-foreign"),
        );
});

afterEach(() => {
    if (ORIGINAL_AUTH_PROVIDER === undefined) delete process.env.AUTH_PROVIDER;
    else process.env.AUTH_PROVIDER = ORIGINAL_AUTH_PROVIDER;
});

describe("row-model access filtering (CWE-639)", () => {
    it("regenerate-cell 404s a row with any source the caller cannot read", async () => {
        const { db, callsFor } = makeFakeDb(respond);
        createServerSupabaseMock.mockReturnValue(db);

        const response = await request(makeApp())
            .post("/api/tabular-review/review-1/regenerate-cell")
            .set("Authorization", "Bearer valid-token")
            .send({ row_id: "row-folder", column_index: 0 });

        expect(response.status).toBe(404);
        expect(filterAccessibleDocumentIdsMock).toHaveBeenCalledWith(
            ["doc-a", "doc-foreign"],
            "user-1",
            "user@example.com",
            db,
        );
        expect(completeTextMock).not.toHaveBeenCalled();
        expect(callsFor("tabular_cells", "update")).toEqual([]);
    });

    it("generate skips rows with any source the caller cannot read", async () => {
        const { db } = makeFakeDb(respond);
        createServerSupabaseMock.mockReturnValue(db);
        streamChatWithToolsMock.mockResolvedValue(undefined);

        const response = await request(makeApp())
            .post("/api/tabular-review/review-1/generate")
            .set("Authorization", "Bearer valid-token")
            .send({ expected_updated_at: REVIEW.updated_at });

        expect(response.status).toBe(200);
        expect(streamChatWithToolsMock).toHaveBeenCalledTimes(1);
        expect(response.text).toContain('"row_id":"row-doc"');
        expect(response.text).not.toContain("row-folder");
    });

    it("POST / filters document_ids and groups same-folder documents into one row", async () => {
        const docs = [
            { id: "doc-a", current_version_id: null, project_id: "p-1", folder_id: "f-1", library_folder_id: null },
            { id: "doc-b", current_version_id: null, project_id: "p-1", folder_id: "f-1", library_folder_id: null },
            { id: "doc-c", current_version_id: null, project_id: "p-1", folder_id: null, library_folder_id: null },
        ];
        const { db, callsFor } = makeFakeDb((call) => {
            if (call.table === "tabular_reviews" && call.op === "insert")
                return { data: [{ ...(call.payload as object), id: "review-new" }], error: null };
            if (call.table === "tabular_review_rows" && call.op === "insert")
                return {
                    data: (call.payload as { sort_index: number }[]).map((row) => ({
                        ...row,
                        id: `row-${row.sort_index}`,
                    })),
                    error: null,
                };
            if (call.table === "documents" && call.op === "select")
                return { data: docs, error: null };
            if (call.table === "project_subfolders" && call.op === "select")
                return { data: [{ id: "f-1", name: "Leases", parent_folder_id: null }], error: null };
            return { data: [], error: null };
        });
        createServerSupabaseMock.mockReturnValue(db);

        const response = await request(makeApp())
            .post("/api/tabular-review")
            .set("Authorization", "Bearer valid-token")
            .send({
                title: "Grouped",
                document_ids: ["doc-a", "doc-b", "doc-c", "doc-foreign"],
                columns_config: [{ index: 0, name: "Parties", prompt: "Who?" }],
                document_grouping: "folder",
            });

        expect(response.status).toBe(201);
        const [reviewInsert] = callsFor("tabular_reviews", "insert");
        expect(reviewInsert.payload).toMatchObject({
            document_ids: ["doc-a", "doc-b", "doc-c"],
            document_grouping: "folder",
        });
        const [rowInsert] = callsFor("tabular_review_rows", "insert");
        expect(
            (rowInsert.payload as { label: string; row_type: string }[]).map(
                (row) => [row.label, row.row_type],
            ),
        ).toEqual([
            ["Leases", "folder"],
            ["Untitled document", "document"],
        ]);
        const [sourceInsert] = callsFor("tabular_review_row_sources", "insert");
        expect(sourceInsert.payload).toEqual([
            { row_id: "row-0", document_id: "doc-a", sort_index: 0 },
            { row_id: "row-0", document_id: "doc-b", sort_index: 1 },
            { row_id: "row-1", document_id: "doc-c", sort_index: 0 },
        ]);
        const [cellInsert] = callsFor("tabular_cells", "insert");
        expect(
            (cellInsert.payload as { row_id: string; document_id: string | null }[]).map(
                (cell) => [cell.row_id, cell.document_id],
            ),
        ).toEqual([
            ["row-0", null],
            ["row-1", "doc-c"],
        ]);
    });
});

describe("review-row load failures answer 500 instead of hanging (sync-log 5f996cf6)", () => {
    function failingRowsDb() {
        return makeFakeDb((call) =>
            call.table === "tabular_review_rows" && call.op === "select"
                ? { data: null, error: { message: "rows unavailable" } }
                : respond(call),
        ).db;
    }

    it("GET /:reviewId", async () => {
        createServerSupabaseMock.mockReturnValue(failingRowsDb());

        const response = await request(makeApp())
            .get("/api/tabular-review/review-1")
            .set("Authorization", "Bearer valid-token");

        expect(response.status).toBe(500);
    });

    it("POST /:reviewId/regenerate-cell", async () => {
        createServerSupabaseMock.mockReturnValue(failingRowsDb());

        const response = await request(makeApp())
            .post("/api/tabular-review/review-1/regenerate-cell")
            .set("Authorization", "Bearer valid-token")
            .send({ row_id: "row-doc", column_index: 0 });

        expect(response.status).toBe(500);
        expect(completeTextMock).not.toHaveBeenCalled();
    });

    it("POST /:reviewId/generate", async () => {
        createServerSupabaseMock.mockReturnValue(failingRowsDb());

        const response = await request(makeApp())
            .post("/api/tabular-review/review-1/generate")
            .set("Authorization", "Bearer valid-token")
            .send({ expected_updated_at: REVIEW.updated_at });

        expect(response.status).toBe(500);
        expect(streamChatWithToolsMock).not.toHaveBeenCalled();
    });

    it("regenerate-cell marks the cell as error when its sources fail to load", async () => {
        const { db, callsFor } = makeFakeDb((call) =>
            call.table === "documents" && call.op === "select"
                ? { data: null, error: { message: "documents unavailable" } }
                : respond(call),
        );
        createServerSupabaseMock.mockReturnValue(db);

        const response = await request(makeApp())
            .post("/api/tabular-review/review-1/regenerate-cell")
            .set("Authorization", "Bearer valid-token")
            .send({ row_id: "row-doc", column_index: 0 });

        expect(response.status).toBe(500);
        expect(completeTextMock).not.toHaveBeenCalled();
        const updates = callsFor("tabular_cells", "update").map(
            (call) => (call.payload as { status: string }).status,
        );
        expect(callsFor("claim_tabular_review_cell", "rpc")).toHaveLength(1);
        expect(updates).toEqual(["error"]);
    });
});

describe("tabular generation leases", () => {
    const runningReview = {
        ...REVIEW,
        active_generation_id: "22222222-2222-4222-8222-222222222222",
        generation_lease_expires_at: "2099-01-01T00:00:00.000Z",
    };

    it("rejects clear and regenerate mutations while another generation owns the lease", async () => {
        const { db, callsFor } = makeFakeDb((call) =>
            call.table === "tabular_reviews" && call.op === "select"
                ? { data: [runningReview], error: null }
                : respond(call),
        );
        createServerSupabaseMock.mockReturnValue(db);

        const clear = await request(makeApp())
            .post("/api/tabular-review/review-1/clear-cells")
            .set("Authorization", "Bearer valid-token")
            .send({ row_ids: ["row-doc"] });
        const regenerate = await request(makeApp())
            .post("/api/tabular-review/review-1/regenerate-cell")
            .set("Authorization", "Bearer valid-token")
            .send({ row_id: "row-doc", column_index: 0 });

        expect([clear.status, regenerate.status]).toEqual([409, 409]);
        expect(clear.body.code).toBe("review_running");
        expect(regenerate.body.code).toBe("review_running");
        expect(callsFor("tabular_cells", "update")).toEqual([]);
        expect(completeTextMock).not.toHaveBeenCalled();
    });

    it("honors an atomic running response after the initial clear-cells read", async () => {
        const { db, callsFor } = makeFakeDb((call) =>
            call.table === "begin_tabular_review_generation"
                ? { data: "running", error: null }
                : respond(call),
        );
        createServerSupabaseMock.mockReturnValue(db);

        const response = await request(makeApp())
            .post("/api/tabular-review/review-1/clear-cells")
            .set("Authorization", "Bearer valid-token")
            .send({ row_ids: ["row-doc"] });

        expect(response.status).toBe(409);
        expect(response.body.code).toBe("review_running");
        expect(callsFor("begin_tabular_review_generation", "rpc")).toHaveLength(1);
        expect(callsFor("tabular_cells", "update")).toEqual([]);
    });

    it("refuses a clear when its lease expires before the cell write", async () => {
        const { db, callsFor } = makeFakeDb((call) =>
            call.table === "clear_tabular_review_cells"
                ? { data: false, error: null }
                : respond(call),
        );
        createServerSupabaseMock.mockReturnValue(db);

        const response = await request(makeApp())
            .post("/api/tabular-review/review-1/clear-cells")
            .set("Authorization", "Bearer valid-token")
            .send({ row_ids: ["row-doc"] });

        expect(response.status).toBe(409);
        expect(response.body.code).toBe("review_stale");
        expect(callsFor("tabular_cells", "update")).toEqual([]);
        expect(callsFor("finish_tabular_review_generation", "rpc")).toHaveLength(1);
    });

    it("refuses a cell start after the review lease changes owner", async () => {
        const { db, callsFor } = makeFakeDb((call) =>
            call.table === "claim_tabular_review_cell"
                ? { data: false, error: null }
                : respond(call),
        );
        createServerSupabaseMock.mockReturnValue(db);

        const response = await request(makeApp())
            .post("/api/tabular-review/review-1/regenerate-cell")
            .set("Authorization", "Bearer valid-token")
            .send({ row_id: "row-doc", column_index: 0 });

        expect(response.status).toBe(409);
        expect(response.body.code).toBe("review_stale");
        expect(callsFor("tabular_cells", "update")).toEqual([]);
        expect(completeTextMock).not.toHaveBeenCalled();
    });

    it("claims before loading rows and cells, then releases after a failed snapshot", async () => {
        const { db, calls } = makeFakeDb((call) =>
            call.table === "tabular_cells" && call.op === "select"
                ? { data: null, error: { message: "private cell snapshot failure" } }
                : respond(call),
        );
        createServerSupabaseMock.mockReturnValue(db);

        const response = await request(makeApp())
            .post("/api/tabular-review/review-1/generate")
            .set("Authorization", "Bearer valid-token")
            .send({ expected_updated_at: REVIEW.updated_at });

        expect(response.status).toBe(500);
        const names = calls.map((call) => `${call.op}:${call.table}`);
        const begin = names.indexOf("rpc:begin_tabular_review_generation");
        const rows = names.indexOf("select:tabular_review_rows");
        const cells = names.indexOf("select:tabular_cells");
        const finish = names.indexOf("rpc:finish_tabular_review_generation");
        expect(begin).toBeGreaterThanOrEqual(0);
        expect(rows).toBeGreaterThan(begin);
        expect(cells).toBeGreaterThan(rows);
        expect(finish).toBeGreaterThan(cells);
        expect(streamChatWithToolsMock).not.toHaveBeenCalled();
    });
});

// Inverted by OSS-6 step D: the frontend now renders sheet/cell citations
// (SpreadsheetView + citation-utils), so both prompts carry upstream's
// spreadsheet citation sentence again (was 172cd8f1's "absent" assertion).
const SHEET_CITATION_FORMAT =
    "[[document:SOURCE_DOCUMENT_ID||sheet:SHEET_NAME||cell:A1||quote:exact cell text]]";

describe("tabular cell prompts (page and spreadsheet citations, sync-log 6ae1f98d)", () => {
    it("regenerate-cell asks for page citations and sheet/cell citations for spreadsheets", async () => {
        const { db } = makeFakeDb(respond);
        createServerSupabaseMock.mockReturnValue(db);

        const response = await request(makeApp())
            .post("/api/tabular-review/review-1/regenerate-cell")
            .set("Authorization", "Bearer valid-token")
            .send({ row_id: "row-doc", column_index: 0 });

        expect(response.status).toBe(200);
        expect(completeTextMock).toHaveBeenCalledTimes(1);
        const { systemPrompt } = completeTextMock.mock.calls[0][0] as {
            systemPrompt: string;
        };
        expect(systemPrompt).toContain(
            "[[document:SOURCE_DOCUMENT_ID||page:N||",
        );
        expect(systemPrompt).toContain(SHEET_CITATION_FORMAT);
    });

    it("generate asks for page citations and sheet/cell citations for spreadsheets", async () => {
        const { db } = makeFakeDb(respond);
        createServerSupabaseMock.mockReturnValue(db);
        streamChatWithToolsMock.mockResolvedValue(undefined);

        const response = await request(makeApp())
            .post("/api/tabular-review/review-1/generate")
            .set("Authorization", "Bearer valid-token")
            .send({ expected_updated_at: REVIEW.updated_at });

        expect(response.status).toBe(200);
        expect(streamChatWithToolsMock).toHaveBeenCalled();
        for (const [args] of streamChatWithToolsMock.mock.calls) {
            const { systemPrompt } = args as { systemPrompt: string };
            expect(systemPrompt).toContain(
                "[[document:SOURCE_DOCUMENT_ID||page:N||",
            );
            expect(systemPrompt).toContain(SHEET_CITATION_FORMAT);
        }
    });
});
