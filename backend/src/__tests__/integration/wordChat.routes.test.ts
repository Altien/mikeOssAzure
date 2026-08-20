import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

type QueryError = { message: string } | null;
type QueryResult = { data: unknown; error: QueryError };
type RecordedQuery = {
  table: string;
  filters: { column: string; value: unknown }[];
};

const { dbState, recordedQueries, recordedRpcs } = vi.hoisted(() => ({
  dbState: {
    document: { data: { id: "word-document-row-1" }, error: null },
    chatList: { data: [], error: null },
    chatDetail: { data: null, error: null },
    messages: { data: [], error: null },
    rpc: { data: true, error: null },
  } as {
    document: QueryResult;
    chatList: QueryResult;
    chatDetail: QueryResult;
    messages: QueryResult;
    rpc: QueryResult;
  },
  recordedQueries: [] as RecordedQuery[],
  recordedRpcs: [] as { name: string; args: Record<string, unknown> }[],
}));

function resultForAwaitedQuery(table: string): QueryResult {
  if (table === "word_chats") return dbState.chatList;
  if (table === "word_chat_messages") return dbState.messages;
  return { data: null, error: null };
}

function resultForSingleQuery(table: string): QueryResult {
  if (table === "word_documents") return dbState.document;
  if (table === "word_chats") return dbState.chatDetail;
  return { data: null, error: null };
}

function makeQuery(table: string) {
  const recorded: RecordedQuery = { table, filters: [] };
  recordedQueries.push(recorded);

  const query: Record<string, unknown> = {};
  const chain = [
    "select",
    "insert",
    "update",
    "delete",
    "upsert",
    "neq",
    "in",
    "is",
    "or",
    "not",
    "lt",
    "gt",
    "gte",
    "lte",
    "filter",
    "order",
    "limit",
    "range",
    "contains",
  ];
  for (const method of chain) query[method] = vi.fn(() => query);
  query.eq = vi.fn((column: string, value: unknown) => {
    recorded.filters.push({ column, value });
    return query;
  });
  query.single = vi.fn(() => Promise.resolve(resultForSingleQuery(table)));
  query.maybeSingle = vi.fn(() => Promise.resolve(resultForSingleQuery(table)));
  query.then = (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(resultForAwaitedQuery(table)).then(resolve, reject);
  return query;
}

function mockSupabase() {
  return {
    from: vi.fn((table: string) => makeQuery(table)),
    rpc: vi.fn((name: string, args: Record<string, unknown>) => {
      recordedRpcs.push({ name, args });
      return Promise.resolve(dbState.rpc);
    }),
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

import { app } from "../../app";

const DOCUMENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const CHAT_ID = "41eb8f61-d7af-454e-b680-cd28bd65c742";
const MESSAGE_ID = "efca16cc-daca-40ef-83cb-1e974582691c";
const AUTH = ["Authorization", "Bearer test"] as const;

function resetDbState() {
  dbState.document = {
    data: { id: "word-document-row-1" },
    error: null,
  };
  dbState.chatList = { data: [], error: null };
  dbState.chatDetail = { data: null, error: null };
  dbState.messages = { data: [], error: null };
  dbState.rpc = { data: true, error: null };
}

describe("Word chat history routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordedQueries.length = 0;
    recordedRpcs.length = 0;
    resetDbState();
  });

  it("returns an empty list when the document row genuinely does not exist", async () => {
    dbState.document = { data: null, error: null };

    const res = await request(app)
      .get(`/word-chat?document_id=${DOCUMENT_ID}`)
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

    const res = await request(app)
      .get(`/word-chat?document_id=${DOCUMENT_ID}`)
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

    const res = await request(app)
      .get(`/word-chat?document_id=${DOCUMENT_ID}`)
      .set(...AUTH);

    expect(res.status).toBe(500);
    expect(res.body.detail).toBe("Failed to load Word chats");
  });

  it("returns 500 rather than 404 when a detail document lookup fails", async () => {
    dbState.document = {
      data: null,
      error: { message: "document lookup failed" },
    };

    const res = await request(app)
      .get(`/word-chat/${CHAT_ID}?document_id=${DOCUMENT_ID}`)
      .set(...AUTH);

    expect(res.status).toBe(500);
    expect(res.body.detail).toBe("Failed to load Word chat");
  });

  it("returns 500 rather than 404 when the scoped chat lookup fails", async () => {
    dbState.chatDetail = {
      data: null,
      error: { message: "chat lookup failed" },
    };

    const res = await request(app)
      .get(`/word-chat/${CHAT_ID}?document_id=${DOCUMENT_ID}`)
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
    const res = await request(app)
      .get(`/word-chat/${CHAT_ID}?document_id=${DOCUMENT_ID}`)
      .set(...AUTH);

    expect(res.status).toBe(404);
    expect(res.body.detail).toBe("Chat not found");
  });

  it("returns 404 before querying Postgres for a malformed chat id", async () => {
    const res = await request(app)
      .get(`/word-chat/not-a-uuid?document_id=${DOCUMENT_ID}`)
      .set(...AUTH);

    expect(res.status).toBe(404);
    expect(res.body.detail).toBe("Chat not found");
    expect(recordedQueries).toEqual([]);
  });

  it("atomically stores validated edit decisions for the authenticated document", async () => {
    const res = await request(app)
      .patch(
        `/word-chat/messages/${MESSAGE_ID}/edit-decisions?document_id=${DOCUMENT_ID}`,
      )
      .set(...AUTH)
      .send({ decisions: { 0: "accepted", 3: "rejected" } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      edit_decisions: { 0: "accepted", 3: "rejected" },
    });
    expect(recordedRpcs).toEqual([
      {
        name: "merge_word_chat_edit_decisions",
        args: {
          p_user_id: "u1",
          p_client_document_id: DOCUMENT_ID,
          p_message_id: MESSAGE_ID,
          p_decisions: { 0: "accepted", 3: "rejected" },
        },
      },
    ]);
  });

  it("rejects malformed edit decisions before calling Postgres", async () => {
    const res = await request(app)
      .patch(
        `/word-chat/messages/${MESSAGE_ID}/edit-decisions?document_id=${DOCUMENT_ID}`,
      )
      .set(...AUTH)
      .send({ decisions: { "edit-0": "accepted", 1: "pending" } });

    expect(res.status).toBe(400);
    expect(recordedRpcs).toEqual([]);
  });

  it("does not reveal an edit-decision target outside the document scope", async () => {
    dbState.rpc = { data: false, error: null };

    const res = await request(app)
      .patch(
        `/word-chat/messages/${MESSAGE_ID}/edit-decisions?document_id=${DOCUMENT_ID}`,
      )
      .set(...AUTH)
      .send({ decisions: { 0: "accepted" } });

    expect(res.status).toBe(404);
    expect(res.body.detail).toBe("Message not found");
  });
});
