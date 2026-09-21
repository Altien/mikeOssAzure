import { describe, expect, it, vi } from "vitest";
import type { Message } from "@/app/components/shared/types";
import { getChat } from "./mikeApi";
import {
  beginAssistantTurn,
  cancelAssistantTurn,
  getAssistantTurn,
  hasAssistantTurn,
  loadAssistantChat,
  withLiveTurn,
} from "./assistantTurns";
vi.mock("./mikeApi", () => ({ getChat: vi.fn() }));
const getChatMock = vi.mocked(getChat);
const history = { chat: { id: "a" }, messages: [{ role: "assistant", content: "Finished" }] } as Awaited<ReturnType<typeof getChat>>;

const user = (content = "hello", id?: string): Message => ({ role: "user", content, ...(id ? { id } : {}) });
const assistant = (text: string, id?: string): Message => ({
  role: "assistant",
  content: "",
  events: [{ type: "content", text }],
  ...(id ? { id } : {}),
});
const begin = (chatId: string | undefined, cancel = vi.fn()) =>
  beginAssistantTurn(chatId, { userMessage: user(), assistant: assistant(""), cancel });

describe("assistant turn history loading", () => {
  it("returns the current history while a turn is still streaming into the chat", async () => {
    // A returning reader lays the live turn over this snapshot; making the
    // read wait for the stream to end is what left the thread on a loading
    // state for the whole answer.
    getChatMock.mockResolvedValue(history);
    const turn = begin("a");
    try {
      expect(await loadAssistantChat("a")).toEqual(history);
      expect(getChatMock).toHaveBeenCalledWith("a");
      expect(hasAssistantTurn("a")).toBe(true);
    } finally { turn.finish(); getChatMock.mockReset(); }
  });
  it("discards history when a turn starts and finishes during the GET", async () => {
    let finishRead!: (value: typeof history) => void;
    getChatMock.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    getChatMock.mockResolvedValue(history);
    const read = loadAssistantChat("a");
    const turn = begin("a");
    turn.finish();
    finishRead({ ...history, messages: [] });
    expect((await read).messages).toEqual(history.messages);
    expect(getChatMock).toHaveBeenCalledTimes(2);
    getChatMock.mockReset();
  });
  it("retries an invalidated GET even when that stale read fails", async () => {
    let rejectRead!: (error: Error) => void;
    getChatMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
    getChatMock.mockResolvedValue(history);
    const read = loadAssistantChat("a");
    const turn = begin("a");
    turn.finish();
    rejectRead(new Error("stale read failed"));
    expect(await read).toEqual(history);
    getChatMock.mockReset();
  });
  it("propagates load failures and permits retry after completion", async () => {
    getChatMock.mockRejectedValueOnce(new Error("offline"));
    await expect(loadAssistantChat("a")).rejects.toThrow("offline");
    getChatMock.mockResolvedValue(history);
    expect(await loadAssistantChat("a")).toEqual(history);
    getChatMock.mockReset();
  });
  it("waits for the cancellation row when Stop closes the socket before persistence", async () => {
    // The read in flight when Stop lands is retried, and the retry can still
    // precede the backend's write: poll until the row is there.
    getChatMock
      .mockResolvedValueOnce({ ...history, messages: [] })
      .mockResolvedValueOnce({ ...history, messages: [] });
    const saved = { ...history, messages: [{ ...history.messages[0], id: "stopped-answer" }] };
    getChatMock.mockResolvedValue(saved);
    const turn = begin("a");
    turn.identify("a", "stopped-answer");
    const read = loadAssistantChat("a");
    cancelAssistantTurn("a");
    turn.finish();
    expect(await read).toEqual(saved);
    expect(getChatMock).toHaveBeenCalledTimes(3);
    getChatMock.mockReset();
  });
  it("keeps Stop associated with the detached request", () => {
    const cancel = vi.fn();
    const turn = begin("a", cancel);
    cancelAssistantTurn("b");
    expect(cancel).not.toHaveBeenCalled();
    cancelAssistantTurn("a");
    expect(cancel).toHaveBeenCalledOnce();
    turn.cancel();
    expect(cancel).toHaveBeenCalledTimes(2);
    turn.finish();
    expect(hasAssistantTurn("a")).toBe(false);
  });
  it("gives up when the server never stores the response", async () => {
    // Stop closes the socket; if the backend then fails to write the row, the
    // reader must surface a load error instead of polling for it forever.
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(0).mockReturnValue(10_000);
    getChatMock.mockResolvedValue({ ...history, messages: [] });
    const turn = begin("a");
    turn.identify("a", "never-saved");
    const read = loadAssistantChat("a");
    turn.finish();
    await expect(read).rejects.toThrow("Chat response could not be loaded");
    now.mockRestore();
    getChatMock.mockReset();
  });
  it("ignores turns, identities and reads that belong to another chat", async () => {
    const cancel = vi.fn();
    cancelAssistantTurn(undefined);
    expect(cancel).not.toHaveBeenCalled();
    // A turn with no chat id yet is registered only once the stream names one.
    const anonymous = begin(undefined, cancel);
    expect(hasAssistantTurn(undefined)).toBe(false);
    expect(getAssistantTurn(undefined)).toBeNull();
    anonymous.finish();
    // identify() after finish must not resurrect the turn.
    anonymous.identify("a", "late");
    expect(hasAssistantTurn("a")).toBe(false);

    let finishRead!: (value: typeof history) => void;
    getChatMock.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    const read = loadAssistantChat("a");
    // Another chat's turn starting mid-GET must not invalidate this read.
    const other = begin("b");
    finishRead(history);
    expect(await read).toEqual(history);
    expect(getChatMock).toHaveBeenCalledTimes(1);
    other.finish();
    getChatMock.mockReset();
  });
});

describe("live assistant turn record", () => {
  it("publishes the assistant message to subscribers as the stream builds it", () => {
    const turn = begin("a");
    const live = getAssistantTurn("a");
    expect(live).toBe(turn.turn);
    const listener = vi.fn();
    const unsubscribe = live!.subscribe(listener);

    turn.update((message) => ({ ...message, events: [{ type: "content", text: "Par", isStreaming: true }] }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(live!.assistant.events).toEqual([{ type: "content", text: "Par", isStreaming: true }]);

    turn.identify("a", "answer-1");
    expect(live!.assistant.id).toBe("answer-1");
    expect(listener).toHaveBeenCalledTimes(2);
    // Re-announcing the same identity is not a change.
    turn.identify("a", "answer-1");
    expect(listener).toHaveBeenCalledTimes(2);

    turn.setLoadingCitations(true);
    expect(live!.loadingCitations).toBe(true);
    expect(listener).toHaveBeenCalledTimes(3);
    // Repeating the same flag is not a change either.
    turn.setLoadingCitations(true);
    expect(listener).toHaveBeenCalledTimes(3);

    turn.finish();
    expect(live!.finished).toBe(true);
    expect(live!.loadingCitations).toBe(false);
    expect(listener).toHaveBeenCalledTimes(4);
    expect(getAssistantTurn("a")).toBeNull();
    // Stop and the request unwinding both finish the turn; the second is a no-op.
    turn.finish();
    expect(listener).toHaveBeenCalledTimes(4);
    // The final message stays readable after the turn has left the registry,
    // and nothing may change it any more.
    turn.update((message) => ({ ...message, events: [] }));
    turn.setLoadingCitations(true);
    expect(live!.assistant.id).toBe("answer-1");
    expect(live!.assistant.events).toHaveLength(1);
    expect(live!.loadingCitations).toBe(false);
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
  });
  it("hands a returning reader the newest turn for the chat", () => {
    const first = begin("a");
    const second = begin("a");
    expect(getAssistantTurn("a")).toBe(second.turn);
    second.finish();
    expect(getAssistantTurn("a")).toBe(first.turn);
    first.finish();
    expect(getAssistantTurn("a")).toBeNull();
  });
});

describe("withLiveTurn", () => {
  const turnOn = (messages: { userMessage: Message | null; assistant: Message }) =>
    beginAssistantTurn(undefined, { ...messages, cancel: vi.fn() }).turn;

  it("leaves the transcript alone without a turn", () => {
    const transcript = [user("hi", "u1")];
    expect(withLiveTurn(transcript, null)).toBe(transcript);
  });
  it("replaces the stored row that carries the turn's message id", () => {
    const live = turnOn({ userMessage: user(), assistant: assistant("Streaming", "answer-1") });
    const transcript = [user("hello", "u1"), assistant("", "answer-1"), user("later", "u2")];
    expect(withLiveTurn(transcript, live)).toEqual([
      transcript[0],
      live.assistant,
      transcript[2],
    ]);
  });
  it("replaces the sender's own placeholder before the stream names the row", () => {
    const live = turnOn({ userMessage: user(), assistant: assistant("Streaming") });
    const transcript = [user("hello"), assistant("")];
    expect(withLiveTurn(transcript, live)).toEqual([transcript[0], live.assistant]);
  });
  it("appends the answer after the user row the server already stored", () => {
    // History hides the reserved assistant row until it has content, so the
    // loaded transcript ends with the user's question.
    const live = turnOn({ userMessage: user("hello"), assistant: assistant("Streaming", "answer-1") });
    const transcript = [assistant("Earlier", "answer-0"), user("hello", "u1")];
    expect(withLiveTurn(transcript, live)).toEqual([...transcript, live.assistant]);
  });
  it("matches the stored question by id when the turn's user message carries one", () => {
    const live = turnOn({ userMessage: user("hello", "u1"), assistant: assistant("Streaming", "answer-1") });
    expect(withLiveTurn([user("hello", "u1")], live)).toEqual([user("hello", "u1"), live.assistant]);
    // Same words, different row: not this turn's question.
    expect(withLiveTurn([user("hello", "u0")], live)).toEqual([user("hello", "u0"), live.userMessage, live.assistant]);
  });
  it("appends both messages when the history predates the question", () => {
    const live = turnOn({ userMessage: user("hello"), assistant: assistant("Streaming", "answer-1") });
    const transcript = [user("earlier", "u0"), assistant("Earlier", "answer-0")];
    expect(withLiveTurn(transcript, live)).toEqual([...transcript, live.userMessage, live.assistant]);
    expect(withLiveTurn([], live)).toEqual([live.userMessage, live.assistant]);
  });
  it("continues the asking message for an ask-inputs answer", () => {
    const live = turnOn({ userMessage: null, assistant: assistant("Continued", "asked") });
    const transcript = [user("hello", "u1"), assistant("Asked", "asked")];
    expect(withLiveTurn(transcript, live)).toEqual([transcript[0], live.assistant]);
    // With no row to continue, only the assistant is added: there is no
    // user bubble for an ask-inputs answer.
    const fresh = turnOn({ userMessage: null, assistant: assistant("Continued") });
    expect(withLiveTurn([user("hello", "u1")], fresh)).toEqual([user("hello", "u1"), fresh.assistant]);
  });
  it("is idempotent, so a repeated overlay never duplicates the turn", () => {
    const live = turnOn({ userMessage: user("hello"), assistant: assistant("Streaming") });
    const once = withLiveTurn([user("hello", "u1")], live);
    expect(withLiveTurn(once, live)).toEqual(once);
    const named = turnOn({ userMessage: user("hello"), assistant: assistant("Streaming", "answer-1") });
    const onceNamed = withLiveTurn([], named);
    expect(withLiveTurn(onceNamed, named)).toEqual(onceNamed);
  });
});
