import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  runLLMStream: vi.fn(),
  scheduleMemoryConsolidation: vi.fn(),
  releaseMemoryConversationTurn: vi.fn(),
  prepareWordChatStream: vi.fn(),
  updateAssistantMessage: vi.fn(),
}));

vi.mock("../../../middleware/auth", () => ({
  requireAuth: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
    res.locals.userId = "entra|tenant|user";
    res.locals.userEmail = "user@example.test";
    next();
  },
}));
vi.mock("../../../lib/supabase", () => ({ createServerSupabase: () => ({}) }));
vi.mock("../../../lib/audit", () => ({ enqueueChatTurnAudit: vi.fn(async () => {}) }));
vi.mock("../../../lib/memory/schedule", () => ({
  beginMemoryConversationTurn: vi.fn(),
  releaseMemoryConversationTurn: mocks.releaseMemoryConversationTurn,
  scheduleMemoryConsolidation: mocks.scheduleMemoryConsolidation,
}));
vi.mock("../../chat/chat.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../chat/chat.service")>()),
  runLLMStream: mocks.runLLMStream,
  reserveAssistantMessage: vi.fn(async () => null),
  createReservedAssistantMessageUpdater: vi.fn(() => mocks.updateAssistantMessage),
  persistWordDocumentEdits: vi.fn(async ({ events }: { events: unknown[] }) => ({ events })),
}));
vi.mock("../wordChat.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wordChat.service")>()),
  prepareWordChatStream: mocks.prepareWordChatStream,
  recordWordChatActivity: vi.fn(async () => null),
}));

import { wordChatRouter } from "../wordChat.routes";

const DOCUMENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const CHAT_ID = "41eb8f61-d7af-454e-b680-cd28bd65c742";
const INPUT_ID = "efca16cc-daca-40ef-83cb-1e974582691c";
const memoryTurn = { activityId: "activity-1" };

function app() {
  const result = express();
  result.use(express.json());
  result.use("/word-chat", wordChatRouter);
  return result;
}

function send(storage: "local" | "cloud") {
  return request(app()).post("/word-chat").send({
    messages: [{ role: "user", content: "Revise this clause" }],
    document_id: DOCUMENT_ID,
    document_name: "Contract.docx",
    storage,
    model: "gemini-3-flash-preview",
  });
}

describe("Word chat memory scheduling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepareWordChatStream.mockImplementation(async (_db, args) => ({
      ok: true,
      prepared: {
        chatId: CHAT_ID,
        chatTitle: null,
        lastUserContent: "Revise this clause",
        inputMessageId: args.persistChat ? INPUT_ID : null,
        memoryTurn: args.persistChat ? memoryTurn : null,
        docIndex: {}, docStore: new Map(), apiMessages: [], workflowStore: {}, apiKeys: {},
        selectedModel: "gemini-3-flash-preview", selectedReasoningLevel: undefined,
        fastModel: "gemini-3-flash-preview", nonce: "test-nonce",
      },
    }));
    mocks.runLLMStream.mockResolvedValue({ events: [{ type: "content", text: "Response" }], citations: [] });
    mocks.updateAssistantMessage.mockResolvedValue(null);
    mocks.scheduleMemoryConsolidation.mockResolvedValue({ scheduled: true });
    mocks.releaseMemoryConversationTurn.mockResolvedValue(undefined);
  });

  it("does not curate a local-only turn without a durable transcript", async () => {
    const response = await send("local");
    expect(response.status).toBe(200);
    expect(mocks.runLLMStream).toHaveBeenCalledOnce();
    expect(mocks.scheduleMemoryConsolidation).not.toHaveBeenCalled();
    expect(mocks.releaseMemoryConversationTurn).not.toHaveBeenCalled();
  });

  it("schedules a durable cloud turn after its assistant response is saved", async () => {
    const response = await send("cloud");
    expect(response.status).toBe(200);
    expect(mocks.updateAssistantMessage).toHaveBeenCalledOnce();
    expect(mocks.scheduleMemoryConsolidation).toHaveBeenCalledWith({
      db: expect.anything(), surface: "word", conversationId: CHAT_ID,
      actorUserId: "entra|tenant|user", projectId: null,
      turnId: expect.any(String), turn: memoryTurn,
    });
    expect(mocks.updateAssistantMessage.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.scheduleMemoryConsolidation.mock.invocationCallOrder[0]);
    expect(mocks.releaseMemoryConversationTurn).not.toHaveBeenCalled();
  });

  it("releases a cloud reservation when the model fails", async () => {
    mocks.runLLMStream.mockRejectedValueOnce(new Error("provider failed"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await send("cloud");
      expect(response.status).toBe(200);
      expect(mocks.releaseMemoryConversationTurn).toHaveBeenCalledWith({
        db: expect.anything(), surface: "word", conversationId: CHAT_ID, turn: memoryTurn,
      });
      expect(mocks.scheduleMemoryConsolidation).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });
});
