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

describe("tabular cell prompts (spreadsheet citations deferred, sync-log 6ae1f98d)", () => {
    it("regenerate-cell asks for page citations only, never sheet/cell citations", async () => {
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
        expect(systemPrompt).not.toMatch(/sheet:/i);
    });

    it("generate asks for page citations only, never sheet/cell citations", async () => {
        const { db } = makeFakeDb(respond);
        createServerSupabaseMock.mockReturnValue(db);
        streamChatWithToolsMock.mockResolvedValue(undefined);

        const response = await request(makeApp())
            .post("/api/tabular-review/review-1/generate")
            .set("Authorization", "Bearer valid-token");

        expect(response.status).toBe(200);
        expect(streamChatWithToolsMock).toHaveBeenCalled();
        for (const [args] of streamChatWithToolsMock.mock.calls) {
            const { systemPrompt } = args as { systemPrompt: string };
            expect(systemPrompt).toContain(
                "[[document:SOURCE_DOCUMENT_ID||page:N||",
            );
            expect(systemPrompt).not.toMatch(/sheet:/i);
        }
    });
});
