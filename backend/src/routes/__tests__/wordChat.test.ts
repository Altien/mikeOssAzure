import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { makeFakeDb } from "../../test/helpers/fakeDb";

type QueryError = { message: string } | null;
type QueryResult = { data: unknown; error: QueryError };
type RecordedQuery = {
  table: string;
  filters: { column: string; value: unknown }[];
};

const { dbState, recordedQueries } = vi.hoisted(() => ({
  dbState: {
    document: { data: { id: "word-document-row-1" }, error: null },
    chatList: { data: [], error: null },
    chatDetail: { data: null, error: null },
    messages: { data: [], error: null },
  } as {
    document: QueryResult;
    chatList: QueryResult;
    chatDetail: QueryResult;
    messages: QueryResult;
  },
  recordedQueries: [] as RecordedQuery[],
}));

function mockSupabase() {
  return makeFakeDb((call) => {
    recordedQueries.push({ table: call.table, filters: call.filters.filter(([method]) => method === "eq").map(([, column, value]) => ({ column, value })) });
    if (dbState.document.error?.message === "throw") throw new Error("unavailable");
    if (call.table === "word_documents") return dbState.document;
    if (call.table === "word_chats") return call.filters.some(([, column]) => column === "id") ? dbState.chatDetail : dbState.chatList;
    if (call.table === "word_chat_messages") return dbState.messages;
    return { data: [], error: null };
  }).db;
}

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: vi.fn(() => mockSupabase()),
}));

// Dev (sync-log: 9dbe9d59): exercise real Entra middleware and /api routes.
// Tenant admission has its own suite; these cases focus on user/document scope.
vi.mock("../../middleware/tenantAccess.js", () => ({ tenantAccess: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../../lib/auth/providers/entra.js", () => ({ validateEntraToken: vi.fn(async () => ({ ok: true, principal: { userId: "u1", email: "u1@test.local", roles: ["member"] } })) }));
vi.mock("../../lib/userSettings.js", () => ({ upsertUserProfile: vi.fn(async () => {}), getUserModelSettings: vi.fn(async () => ({api_keys: {}})) }));
import { makeApp } from "../../test/helpers/buildTestApp";
const previousProvider = process.env.AUTH_PROVIDER;
afterEach(() => { if (previousProvider === undefined) delete process.env.AUTH_PROVIDER; else process.env.AUTH_PROVIDER = previousProvider; });

const DOCUMENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const CHAT_ID = "41eb8f61-d7af-454e-b680-cd28bd65c742";
const AUTH = ["Authorization", "Bearer test"] as const;

function resetDbState() {
  dbState.document = {
    data: { id: "word-document-row-1" },
    error: null,
  };
  dbState.chatList = { data: [], error: null };
  dbState.chatDetail = { data: null, error: null };
  dbState.messages = { data: [], error: null };
}

describe("Word chat history routes", () => {
  beforeEach(() => {
    process.env.AUTH_PROVIDER = "entra";
    vi.clearAllMocks();
    recordedQueries.length = 0;
    resetDbState();
  });

  it("returns an empty list when the document row genuinely does not exist", async () => {
    dbState.document = { data: null, error: null };

    const res = await request(makeApp())
      .get(`/api/word-chat?document_id=${DOCUMENT_ID}`)
      .set(...AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(recordedQueries.map(({ table }) => table)).toEqual([
      "word_documents",
    ]);
  });

  it("returns 500 when the document lookup query fails", async () => {
    dbState.document = {
      data: null,
      error: { message: "word_documents is unavailable" },
    };

    const res = await request(makeApp())
      .get(`/api/word-chat?document_id=${DOCUMENT_ID}`)
      .set(...AUTH);

    expect(res.status).toBe(500);
    expect(res.body.detail).toBe("Failed to load Word chats");
    expect(recordedQueries.map(({ table }) => table)).toEqual([
      "word_documents",
    ]);
  });

  it("returns 500 when the document-scoped chat list query fails", async () => {
    dbState.chatList = {
      data: null,
      error: { message: "word_chats is unavailable" },
    };

    const res = await request(makeApp())
      .get(`/api/word-chat?document_id=${DOCUMENT_ID}`)
      .set(...AUTH);

    expect(res.status).toBe(500);
    expect(res.body.detail).toBe("Failed to load Word chats");
  });

  it("returns 500 rather than 404 when a detail document lookup fails", async () => {
    dbState.document = {
      data: null,
      error: { message: "document lookup failed" },
    };

    const res = await request(makeApp())
      .get(`/api/word-chat/${CHAT_ID}?document_id=${DOCUMENT_ID}`)
      .set(...AUTH);

    expect(res.status).toBe(500);
    expect(res.body.detail).toBe("Failed to load Word chat");
  });

  it("returns 500 rather than 404 when the scoped chat lookup fails", async () => {
    dbState.chatDetail = {
      data: null,
      error: { message: "chat lookup failed" },
    };

    const res = await request(makeApp())
      .get(`/api/word-chat/${CHAT_ID}?document_id=${DOCUMENT_ID}`)
      .set(...AUTH);

    expect(res.status).toBe(500);
    expect(res.body.detail).toBe("Failed to load Word chat");
    expect(
      recordedQueries.find(({ table }) => table === "word_chats")?.filters,
    ).toEqual([
      { column: "id", value: CHAT_ID },
      { column: "word_document_id", value: "word-document-row-1" },
      { column: "user_id", value: "u1" },
    ]);
    expect(
      recordedQueries.some(({ table }) => table === "word_chat_messages"),
    ).toBe(false);
  });

  it("keeps a genuinely missing scoped chat as 404", async () => {
    const res = await request(makeApp())
      .get(`/api/word-chat/${CHAT_ID}?document_id=${DOCUMENT_ID}`)
      .set(...AUTH);

    expect(res.status).toBe(404);
    expect(res.body.detail).toBe("Chat not found");
  });

  it("returns 404 before querying Postgres for a malformed chat id", async () => {
    const res = await request(makeApp())
      .get(`/api/word-chat/not-a-uuid?document_id=${DOCUMENT_ID}`)
      .set(...AUTH);

    expect(res.status).toBe(404);
    expect(res.body.detail).toBe("Chat not found");
    expect(recordedQueries).toEqual([]);
  });
});

 it("returns 500 for a thrown lookup instead of hanging", async () => {
 process.env.AUTH_PROVIDER = "entra"; resetDbState(); dbState.document.error = {message: "throw"};
 const res = await request(makeApp()).get(`/api/word-chat?document_id=${DOCUMENT_ID}`).set(...AUTH); expect(res.status).toBe(500);
 });
