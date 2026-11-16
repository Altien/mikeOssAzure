import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  chatAccess: { ok: true } as { ok: boolean },
}));
vi.mock("../../../lib/supabase", () => ({
  createServerSupabase: () => mocks.db,
}));
vi.mock("../../chat/chat.service", () => ({
  getAccessibleChat: vi.fn(async () => mocks.chatAccess),
}));
vi.mock("../../../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.userId = "user-1";
    res.locals.userEmail = "user@example.com";
    next();
  },
}));
import { getAccessibleChat } from "../../chat/chat.service";
import { supportRouter } from "../support.routes";

const app = express();
app.use(express.json());
app.use("/support-reports", supportRouter);

const CHAT = "00000000-0000-4000-8000-000000000010";
const MESSAGE = "00000000-0000-4000-8000-000000000020";
const REPORT = "00000000-0000-4000-8000-000000000030";
const CONSENT = "I allow the support team to inspect this conversation.";
const row = {
  id: REPORT, chat_id: CHAT, project_id: null, message_id: MESSAGE,
  allow_conversation: true, allow_documents: true, created_at: "2026-11-16T00:00:00Z",
  access_expires_at: "2026-11-30T00:00:00Z", withdrawn_at: null,
};
const body = {
  chat_id: CHAT, message_id: MESSAGE, description: "  It cited the wrong clause  ",
  allow_conversation: true, allow_documents: true, consent_text: CONSENT,
};

beforeEach(() => {
  mocks.chatAccess = { ok: true };
  vi.mocked(getAccessibleChat).mockClear();
});

describe("POST /support-reports", () => {
  it("records the caller's report on a readable chat's assistant message", async () => {
    const fake = scriptedDb([
      { table: "chat_messages", data: { id: MESSAGE } },
      { table: "support_reports", op: "insert", data: row },
    ]);
    mocks.db = fake.db;
    const response = await request(app).post("/support-reports").send({ ...body, user_id: "spoofed" }).expect(201);
    expect(response.body).toEqual(row);
    expect(getAccessibleChat).toHaveBeenCalledWith(fake.db, { chatId: CHAT, userId: "user-1", userEmail: "user@example.com" });
    expect(fake.calls[0].filters).toEqual(expect.arrayContaining([
      ["eq", "id", MESSAGE], ["eq", "chat_id", CHAT], ["eq", "role", "assistant"]]));
    expect(fake.calls[1].payload).toEqual({
      user_id: "user-1", chat_id: CHAT, message_id: MESSAGE, description: "It cited the wrong clause",
      allow_conversation: true, allow_documents: true, consent_text: CONSENT,
    });
    fake.done();
  });

  it.each([
    ["no description", { description: "   " }],
    ["an overlong description", { description: "x".repeat(4001) }],
    ["a malformed chat id", { chat_id: "nope" }],
    ["consent without its wording", { consent_text: undefined }],
  ])("rejects %s before touching the database", async (_name, change) => {
    const fake = scriptedDb([]);
    mocks.db = fake.db;
    await request(app).post("/support-reports").send({ ...body, ...change }).expect(400);
    expect(getAccessibleChat).not.toHaveBeenCalled();
    fake.done();
  });

  it("answers 404 for a chat the caller cannot read", async () => {
    mocks.chatAccess = { ok: false };
    const fake = scriptedDb([]);
    mocks.db = fake.db;
    await request(app).post("/support-reports").send(body).expect(404);
    fake.done();
  });

  it("answers 404 for a message outside the chat", async () => {
    const fake = scriptedDb([{ table: "chat_messages", data: null }]);
    mocks.db = fake.db;
    await request(app).post("/support-reports").send(body).expect(404);
    fake.done();
  });

  it("stores a report without consent and without wording", async () => {
    const fake = scriptedDb([
      { table: "chat_messages", data: { id: MESSAGE } },
      { table: "support_reports", op: "insert", data: { ...row, allow_conversation: false, allow_documents: false } },
    ]);
    mocks.db = fake.db;
    await request(app).post("/support-reports")
      .send({ chat_id: CHAT, message_id: MESSAGE, description: "Slow" }).expect(201);
    expect(fake.calls[1].payload).toMatchObject({ allow_conversation: false, allow_documents: false, consent_text: null });
    fake.done();
  });
});

describe("POST /support-reports/:id/withdraw", () => {
  it("withdraws only the caller's own report", async () => {
    const fake = scriptedDb([{ table: "support_reports", op: "update", data: { ...row, withdrawn_at: "now" } }]);
    mocks.db = fake.db;
    const response = await request(app).post(`/support-reports/${REPORT}/withdraw`).expect(200);
    expect(response.body.withdrawn_at).toBe("now");
    expect(fake.calls[0].filters).toEqual([["eq", "id", REPORT], ["eq", "user_id", "user-1"]]);
    fake.done();
  });

  it("answers 404 for someone else's or a malformed report", async () => {
    const fake = scriptedDb([{ table: "support_reports", op: "update", data: null }]);
    mocks.db = fake.db;
    await request(app).post(`/support-reports/${REPORT}/withdraw`).expect(404);
    await request(app).post("/support-reports/not-a-uuid/withdraw").expect(404);
    fake.done();
  });
});
