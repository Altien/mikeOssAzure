import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { makeFakeDb } from "../../test/helpers/fakeDb";

type QueryError = { message: string } | null;
type QueryResult = { data: unknown; error: QueryError };
type RecordedQuery = {
  table: string;
  filters: { column: string; value: unknown }[];
  payload?: unknown;
};

const { dbState, recordedQueries } = vi.hoisted(() => ({
  dbState: {
    document: { data: { id: "word-document-row-1" }, error: null },
    chatList: { data: [], error: null },
    chatDetail: { data: null, error: null },
    messages: { data: [], error: null },
    messageDetail: { data: null, error: null },
    edits: { data: [], error: null },
    editDetail: { data: null, error: null },
  } as {
    document: QueryResult;
    chatList: QueryResult;
    chatDetail: QueryResult;
    messages: QueryResult;
    messageDetail: QueryResult;
    edits: QueryResult;
    editDetail: QueryResult;
  },
  recordedQueries: [] as RecordedQuery[],
}));

function mockSupabase() {
  return makeFakeDb((call) => {
    recordedQueries.push({ table: call.table, filters: call.filters.filter(([method]) => method === "eq").map(([, column, value]) => ({ column, value })) });
    if (call.table === "word_documents" && dbState.document.error?.message === "throw") throw new Error("unavailable");
    if (call.table === "word_documents") return dbState.document;
    if (call.table === "word_chats") return call.filters.some(([, column]) => column === "id") ? dbState.chatDetail : dbState.chatList;
    if (call.table === "word_chat_messages") return call.filters.some(([, column]) => column === "id") ? dbState.messageDetail : dbState.messages;
    if (call.table === "word_document_edits") return call.filters.some(([method]) => method === "in") ? dbState.edits : dbState.editDetail;
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
vi.mock("../../lib/userLookup.js", () => ({ upsertUserProfile: vi.fn(async () => {}) }));
import { makeApp } from "../../test/helpers/buildTestApp";
const previousProvider = process.env.AUTH_PROVIDER;
afterEach(() => { if (previousProvider === undefined) delete process.env.AUTH_PROVIDER; else process.env.AUTH_PROVIDER = previousProvider; });

const DOCUMENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const CHAT_ID = "41eb8f61-d7af-454e-b680-cd28bd65c742";
const MESSAGE_ID = "efca16cc-daca-40ef-83cb-1e974582691c";
const AUTH = ["Authorization", "Bearer test"] as const;
const wordQueries = () => recordedQueries.filter(({ table }) => table.startsWith("word_"));

function resetDbState() {
  dbState.document = {
    data: { id: "word-document-row-1" },
    error: null,
  };
  dbState.chatList = { data: [], error: null };
  dbState.chatDetail = { data: null, error: null };
  dbState.messages = { data: [], error: null };
  dbState.messageDetail = { data: null, error: null };
  dbState.edits = { data: [], error: null };
  dbState.editDetail = { data: null, error: null };
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
    expect(wordQueries().map(({ table }) => table)).toEqual([
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
    expect(res.body.detail).toBe("Something went wrong. Please try again.");
    expect(wordQueries().map(({ table }) => table)).toEqual([
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
    expect(res.body.detail).toBe("Something went wrong. Please try again.");
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
    expect(res.body.detail).toBe("Something went wrong. Please try again.");
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
    expect(res.body.detail).toBe("Something went wrong. Please try again.");
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

  it("hydrates normalized edits alongside their assistant message", async () => {
    dbState.chatDetail = {
      data: {
        id: CHAT_ID,
        user_id: "u1",
        word_document_id: "word-document-row-1",
      },
      error: null,
    };
    dbState.messages = {
      data: [
        {
          id: MESSAGE_ID,
          chat_id: CHAT_ID,
          role: "assistant",
          content: [{ type: "word_edit_ref", edit_id: "edit-1" }],
        },
      ],
      error: null,
    };
    dbState.edits = {
      data: [
        {
          id: "edit-1",
          word_chat_message_id: MESSAGE_ID,
          block_index: 0,
          original_text: "ten days",
          replacement_text: "five days",
        },
      ],
      error: null,
    };

    const res = await request(makeApp())
      .get(`/api/word-chat/${CHAT_ID}?document_id=${DOCUMENT_ID}`)
      .set(...AUTH);

    expect(res.status).toBe(200);
    expect(res.body.messages[0].edits).toEqual(dbState.edits.data);
  });

  it("returns 404 before querying Postgres for a malformed chat id", async () => {
    const res = await request(makeApp())
      .get(`/api/word-chat/not-a-uuid?document_id=${DOCUMENT_ID}`)
      .set(...AUTH);

    expect(res.status).toBe(404);
    expect(res.body.detail).toBe("Chat not found");
    expect(wordQueries()).toEqual([]);
  });

  it("idempotently stores a normalized edit for the authenticated document", async () => {
    dbState.messageDetail = {
      data: { id: MESSAGE_ID, chat_id: CHAT_ID, role: "assistant" },
      error: null,
    };
    dbState.chatDetail = {
      data: {
        id: CHAT_ID,
        user_id: "u1",
        word_document_id: "word-document-row-1",
      },
      error: null,
    };
    dbState.editDetail = {
      data: {
        id: "edit-1",
        word_chat_message_id: MESSAGE_ID,
        block_index: 0,
      },
      error: null,
    };
    const res = await request(makeApp())
      .put(
        `/api/word-chat/messages/${MESSAGE_ID}/edits/0?document_id=${DOCUMENT_ID}`,
      )
      .set(...AUTH)
      .send({
        original_text: "ten days",
        replacement_text: "five days",
        formats: [],
        reason: "Shortens the cure period",
        apply_mode: "approval",
      });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("edit-1");
    expect(recordedQueries.map(({ table }) => table)).toContain(
      "word_document_edits",
    );
  });

  it("rejects malformed normalized edits before querying their message", async () => {
    const res = await request(makeApp())
      .put(
        `/api/word-chat/messages/${MESSAGE_ID}/edits/0?document_id=${DOCUMENT_ID}`,
      )
      .set(...AUTH)
      .send({ original_text: "", apply_mode: "approval" });

    expect(res.status).toBe(400);
    expect(wordQueries()).toEqual([]);
  });

  it("rejects normalized edit anchors longer than the Word protocol limit", async () => {
    const res = await request(makeApp())
      .put(
        `/api/word-chat/messages/${MESSAGE_ID}/edits/0?document_id=${DOCUMENT_ID}`,
      )
      .set(...AUTH)
      .send({
        original_text: "x".repeat(201),
        replacement_text: "replacement",
        formats: [],
        apply_mode: "approval",
      });

    expect(res.status).toBe(400);
    expect(res.body.detail).toBe(
      "original_text must be at most 200 characters",
    );
    expect(wordQueries()).toEqual([]);
  });

  it("does not reveal a normalized edit target outside the document scope", async () => {
    dbState.messageDetail = {
      data: { id: MESSAGE_ID, chat_id: CHAT_ID, role: "assistant" },
      error: null,
    };

    const res = await request(makeApp())
      .patch(
        `/api/word-chat/messages/${MESSAGE_ID}/edits/0?document_id=${DOCUMENT_ID}`,
      )
      .set(...AUTH)
      .send({ resolution_status: "accepted" });

    expect(res.status).toBe(404);
    expect(res.body.detail).toBe("Message not found");
  });
});

 it("returns 500 for a thrown lookup instead of hanging", async () => {
 process.env.AUTH_PROVIDER = "entra"; resetDbState(); dbState.document.error = {message: "throw"};
 const res = await request(makeApp()).get(`/api/word-chat?document_id=${DOCUMENT_ID}`).set(...AUTH); expect(res.status).toBe(500);
 });

describe("POST /api/word-chat/tool-result", () => {
  const TOOL_CALL_ID = "7f0e19cf-9be0-4b53-a1c4-2f2ffb92e611";
  beforeEach(() => { process.env.AUTH_PROVIDER = "entra"; resetDbState(); });

  it("rejects malformed IDs and gives the same 404 for unknown calls", async () => {
    const app = makeApp();
    const malformed = await request(app).post("/api/word-chat/tool-result")
      .set(...AUTH).send({ tool_call_id: "not-a-uuid", result: {} });
    expect(malformed.status).toBe(400);
    expect(malformed.body.detail).toBe("tool_call_id must be a UUID");
    const missing = await request(app).post("/api/word-chat/tool-result")
      .set(...AUTH).send({ tool_call_id: TOOL_CALL_ID, result: {} });
    expect(missing.status).toBe(404);
    expect(missing.body.detail).toBe("Unknown or expired tool call");
  });

  it("delivers once to the authenticated owner then expires", async () => {
    const { waitForClientToolResult } = await import("../../modules/chat/engine/tools/wordClientTools.js");
    const pending = waitForClientToolResult({ callId: TOOL_CALL_ID, userId: "u1" });
    const app = makeApp();
    const first = await request(app).post("/api/word-chat/tool-result").set(...AUTH)
      .send({ tool_call_id: TOOL_CALL_ID, result: { edits: [{ index: 0, status: "proposed" }] } });
    expect(first.status).toBe(204);
    await expect(pending).resolves.toEqual({ edits: [{ index: 0, status: "proposed" }] });
    const second = await request(app).post("/api/word-chat/tool-result").set(...AUTH)
      .send({ tool_call_id: TOOL_CALL_ID, result: {} });
    expect(second.status).toBe(404);
  });

  it("does not deliver another user's pending result", async () => {
    const { waitForClientToolResult, submitClientToolResult } = await import("../../modules/chat/engine/tools/wordClientTools.js");
    const pending = waitForClientToolResult({ callId: TOOL_CALL_ID, userId: "someone-else" });
    const response = await request(makeApp()).post("/api/word-chat/tool-result").set(...AUTH)
      .send({ tool_call_id: TOOL_CALL_ID, result: {} });
    expect(response.status).toBe(404);
    submitClientToolResult(TOOL_CALL_ID, "someone-else", {});
    await pending;
  });
});
