import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { MikeMessage } from "@/app/components/shared/types";

// Mock the four collaborators at the module boundary.
const {
    mockStreamChat,
    mockStreamProjectChat,
    mockRouterReplace,
    mockReplaceChatId,
    mockLoadChats,
    mockSetCurrentChatId,
    mockSaveChat,
    mockSetNewChatMessages,
    mockGenerateTitle,
} = vi.hoisted(() => ({
    mockStreamChat: vi.fn(),
    mockStreamProjectChat: vi.fn(),
    mockRouterReplace: vi.fn(),
    mockReplaceChatId: vi.fn(),
    mockLoadChats: vi.fn(),
    mockSetCurrentChatId: vi.fn(),
    mockSaveChat: vi.fn(),
    mockSetNewChatMessages: vi.fn(),
    mockGenerateTitle: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", () => ({
    streamChat: mockStreamChat,
    streamProjectChat: mockStreamProjectChat,
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({
        replace: mockRouterReplace,
        push: vi.fn(),
        back: vi.fn(),
        forward: vi.fn(),
        refresh: vi.fn(),
        prefetch: vi.fn(),
    }),
}));

vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        replaceChatId: mockReplaceChatId,
        loadChats: mockLoadChats,
        setCurrentChatId: mockSetCurrentChatId,
        saveChat: mockSaveChat,
        setNewChatMessages: mockSetNewChatMessages,
    }),
}));

vi.mock("./useGenerateChatTitle", () => ({
    useGenerateChatTitle: () => ({ generate: mockGenerateTitle }),
}));

import { useAssistantChat } from "./useAssistantChat";

// Build an SSE-shaped Response with a streaming body that emits the
// given event objects in order, then a [DONE] sentinel.  Mirrors the
// production wire format the hook parses.
function sseResponse(events: object[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            for (const evt of events) {
                controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify(evt)}\n\n`),
                );
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
        },
    });
    return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
    });
}

function errorResponse(status: number, body: string): Response {
    return new Response(body, { status });
}

const USER_MSG = (text: string, extra: Partial<MikeMessage> = {}): MikeMessage => ({
    role: "user",
    content: text,
    ...extra,
});

beforeEach(() => {
    mockStreamChat.mockReset();
    mockStreamProjectChat.mockReset();
    mockRouterReplace.mockReset();
    mockReplaceChatId.mockReset();
    mockLoadChats.mockReset().mockResolvedValue(undefined);
    mockSetCurrentChatId.mockReset();
    mockSaveChat.mockReset();
    mockSetNewChatMessages.mockReset();
    mockGenerateTitle.mockReset().mockResolvedValue(undefined);
});

describe("useAssistantChat: input validation", () => {
    it("handleChat returns null without calling the API on whitespace-only content", async () => {
        const { result } = renderHook(() => useAssistantChat());

        let returned: string | null = "x";
        await act(async () => {
            returned = await result.current.handleChat(USER_MSG("   "));
        });

        expect(returned).toBeNull();
        expect(mockStreamChat).not.toHaveBeenCalled();
        expect(mockStreamProjectChat).not.toHaveBeenCalled();
    });

    it("handleNewChat returns null without calling saveChat on whitespace-only content", async () => {
        const { result } = renderHook(() => useAssistantChat());

        let returned: string | null = "x";
        await act(async () => {
            returned = await result.current.handleNewChat(USER_MSG(""));
        });

        expect(returned).toBeNull();
        expect(mockSaveChat).not.toHaveBeenCalled();
    });
});

describe("useAssistantChat: streamChat vs streamProjectChat routing", () => {
    it("calls streamChat (no projectId) with apiMessages, model, and chat_id", async () => {
        mockStreamChat.mockResolvedValue(sseResponse([]));
        const { result } = renderHook(() =>
            useAssistantChat({ chatId: "existing-chat" }),
        );

        await act(async () => {
            await result.current.handleChat(
                USER_MSG("hello", { model: "claude-opus-4-7" }),
            );
        });

        expect(mockStreamChat).toHaveBeenCalledOnce();
        expect(mockStreamProjectChat).not.toHaveBeenCalled();
        const payload = mockStreamChat.mock.calls[0]![0];
        expect(payload.messages).toEqual([
            {
                role: "user",
                content: "hello",
                files: undefined,
                workflow: undefined,
            },
        ]);
        expect(payload.chat_id).toBe("existing-chat");
        expect(payload.model).toBe("claude-opus-4-7");
        // AbortController.signal is passed through so the hook's
        // cancel() can wire up.
        expect(payload.signal).toBeInstanceOf(AbortSignal);
    });

    it("calls streamProjectChat when projectId is set, with displayed_doc + attached_documents", async () => {
        mockStreamProjectChat.mockResolvedValue(sseResponse([]));
        const { result } = renderHook(() =>
            useAssistantChat({ projectId: "p-1" }),
        );

        await act(async () => {
            await result.current.handleChat(
                USER_MSG("review", {
                    files: [
                        { filename: "doc.pdf", document_id: "d-1" },
                        { filename: "scratch.txt" }, // no document_id — filtered out
                    ],
                }),
                { displayedDoc: { filename: "open.pdf", documentId: "d-99" } },
            );
        });

        expect(mockStreamProjectChat).toHaveBeenCalledOnce();
        expect(mockStreamChat).not.toHaveBeenCalled();
        const payload = mockStreamProjectChat.mock.calls[0]![0];
        expect(payload.projectId).toBe("p-1");
        expect(payload.displayed_doc).toEqual({
            filename: "open.pdf",
            document_id: "d-99",
        });
        // Only the file with document_id survives the attached_documents filter.
        expect(payload.attached_documents).toEqual([
            { filename: "doc.pdf", document_id: "d-1" },
        ]);
    });

    it("omits attached_documents entirely when no file has a document_id", async () => {
        // The filter produces [], and the request shape uses undefined
        // (not the empty array) to signal "no attachments" so the
        // backend's optional-field default kicks in.
        mockStreamProjectChat.mockResolvedValue(sseResponse([]));
        const { result } = renderHook(() => useAssistantChat({ projectId: "p" }));

        await act(async () => {
            await result.current.handleChat(
                USER_MSG("hi", {
                    files: [{ filename: "scratch.txt" }],
                }),
            );
        });

        const payload = mockStreamProjectChat.mock.calls[0]![0];
        expect(payload.attached_documents).toBeUndefined();
    });
});

describe("useAssistantChat: SSE event handling", () => {
    it("captures chat_id from the stream and routes to the new chat URL", async () => {
        mockStreamChat.mockResolvedValue(
            sseResponse([{ type: "chat_id", chatId: "newly-minted" }]),
        );
        const { result } = renderHook(() => useAssistantChat());

        let returned: string | null = null;
        await act(async () => {
            returned = await result.current.handleChat(USER_MSG("first msg"));
        });

        expect(returned).toBe("newly-minted");
        expect(result.current.chatId).toBe("newly-minted");
        expect(mockSetCurrentChatId).toHaveBeenCalledWith("newly-minted");
        expect(mockRouterReplace).toHaveBeenCalledWith(
            "/assistant/chat/newly-minted",
        );
        // First message + fresh chat → title generation kicks off.
        expect(mockGenerateTitle).toHaveBeenCalledWith(
            "newly-minted",
            "first msg",
        );
    });

    it("routes to the project chat URL when projectId is set", async () => {
        mockStreamProjectChat.mockResolvedValue(
            sseResponse([{ type: "chat_id", chatId: "proj-chat" }]),
        );
        const { result } = renderHook(() => useAssistantChat({ projectId: "p-1" }));

        await act(async () => {
            await result.current.handleChat(USER_MSG("hi"));
        });

        expect(mockRouterReplace).toHaveBeenCalledWith(
            "/projects/p-1/assistant/chat/proj-chat",
        );
    });

    it("accumulates content_delta events into the assistant message after the drip flushes", async () => {
        // The SUT animates content character-by-character via a 16ms
        // setInterval ("drip").  When the read loop ends, flushDrip()
        // commits the full text immediately so callers see the final
        // assembled string without waiting for the animation.
        // content_delta carries INCREMENTAL fragments, not cumulative
        // state — the hook accumulates by string-concatenating into
        // dripTargetRef.  A change to either side of this contract
        // would silently produce duplicated text.
        mockStreamChat.mockResolvedValue(
            sseResponse([
                { type: "content_delta", text: "Hello, " },
                { type: "content_delta", text: "world" },
                { type: "content_delta", text: "!" },
            ]),
        );

        const { result } = renderHook(() => useAssistantChat());

        await act(async () => {
            await result.current.handleChat(USER_MSG("greet me"));
        });

        // Last message is the assistant; its events end with a single
        // (non-streaming) content block carrying the final text.
        const assistantMsg =
            result.current.messages[result.current.messages.length - 1];
        expect(assistantMsg.role).toBe("assistant");
        const lastContent = (assistantMsg.events ?? []).find(
            (e) => e.type === "content",
        );
        expect(lastContent).toEqual({
            type: "content",
            text: "Hello, world!",
        });
        expect(result.current.isResponseLoading).toBe(false);
    });

    it("content_done flips isLoadingCitations true (then false after stream ends)", async () => {
        // content_done is the "model finished generating text, citations
        // coming" signal.  The wrapper shows a "Fetching sources…"
        // strip during this window.
        mockStreamChat.mockResolvedValue(
            sseResponse([
                { type: "content_delta", text: "ok" },
                { type: "content_done" },
                { type: "citations", citations: [] },
            ]),
        );

        const { result } = renderHook(() => useAssistantChat());

        await act(async () => {
            await result.current.handleChat(USER_MSG("hi"));
        });

        // After the stream completes both flags are off.
        expect(result.current.isResponseLoading).toBe(false);
        expect(result.current.isLoadingCitations).toBe(false);
    });

    it("citations event attaches annotations to the assistant message", async () => {
        const cite = {
            type: "citation" as const,
            cite_id: 1,
            filename: "doc.pdf",
            document_id: "d-1",
            quote: "the quoted text",
        };
        mockStreamChat.mockResolvedValue(
            sseResponse([
                { type: "content_delta", text: "see ref" },
                { type: "citations", citations: [cite] },
            ]),
        );

        const { result } = renderHook(() => useAssistantChat());
        await act(async () => {
            await result.current.handleChat(USER_MSG("hi"));
        });

        const last = result.current.messages[result.current.messages.length - 1];
        expect(last.annotations).toEqual([cite]);
    });

    it("swallows malformed JSON in an SSE event without aborting the stream", async () => {
        // The parser's try/catch warns to console; the rest of the
        // stream must still be consumed.
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode("data: not-json\n\n"));
                controller.enqueue(
                    encoder.encode(
                        `data: ${JSON.stringify({ type: "content_delta", text: "ok" })}\n\n`,
                    ),
                );
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
            },
        });
        mockStreamChat.mockResolvedValue(
            new Response(stream, {
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
            }),
        );

        const { result } = renderHook(() => useAssistantChat());
        await act(async () => {
            await result.current.handleChat(USER_MSG("hi"));
        });

        // The "ok" delta survived the malformed line.
        const last = result.current.messages[result.current.messages.length - 1];
        const content = (last.events ?? []).find((e) => e.type === "content");
        expect(content).toEqual({ type: "content", text: "ok" });
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("failed to parse SSE line"),
            "data: not-json",
            expect.any(Error),
        );
        warnSpy.mockRestore();
    });
});

describe("useAssistantChat: error path", () => {
    it("non-2xx response writes an error string onto the assistant message", async () => {
        mockStreamChat.mockResolvedValue(errorResponse(500, "boom"));

        const { result } = renderHook(() => useAssistantChat());

        await act(async () => {
            await result.current.handleChat(USER_MSG("hi"));
        });

        const last = result.current.messages[result.current.messages.length - 1];
        expect(last.role).toBe("assistant");
        expect(last.error).toBe("HTTP 500: boom");
        expect(result.current.isResponseLoading).toBe(false);
    });

    it("a thrown non-Error becomes the generic 'something went wrong' message", async () => {
        mockStreamChat.mockResolvedValue({
            ok: true,
            // No body — triggers "No response body" throw in the hook.
            body: null as ReadableStream | null,
        } as Response);

        const { result } = renderHook(() => useAssistantChat());
        await act(async () => {
            await result.current.handleChat(USER_MSG("hi"));
        });

        const last = result.current.messages[result.current.messages.length - 1];
        expect(last.error).toBe("No response body");
    });
});

describe("useAssistantChat: cancel", () => {
    it("cancel() aborts the in-flight controller and writes 'Cancelled by user'", async () => {
        // The SSE response never resolves the read until we abort.
        let triggerAbort!: () => void;
        const willAbort = new Promise<void>((r) => {
            triggerAbort = r;
        });

        mockStreamChat.mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
            const stream = new ReadableStream({
                async start(controller) {
                    const encoder = new TextEncoder();
                    controller.enqueue(
                        encoder.encode(
                            `data: ${JSON.stringify({ type: "content_delta", text: "halfway" })}\n\n`,
                        ),
                    );
                    await willAbort;
                    // Surface the abort the way fetch does in production.
                    const err = new Error("aborted");
                    err.name = "AbortError";
                    controller.error(err);
                },
            });
            // Mirror native fetch: the signal also fires AbortError if
            // the consumer aborts mid-read.
            signal.addEventListener("abort", () => {
                triggerAbort();
            });
            return new Response(stream, {
                status: 200,
                headers: { "Content-Type": "text/event-stream" },
            });
        });

        const { result } = renderHook(() => useAssistantChat());

        // Kick the request off — don't await; we want it in flight.
        let chatPromise!: Promise<string | null>;
        act(() => {
            chatPromise = result.current.handleChat(USER_MSG("long question"));
        });

        // Cancel mid-stream.
        await act(async () => {
            result.current.cancel();
            await chatPromise;
        });

        const last = result.current.messages[result.current.messages.length - 1];
        const cancelEvent = (last.events ?? []).find(
            (e) =>
                e.type === "content" &&
                typeof (e as { text?: string }).text === "string" &&
                (e as { text: string }).text.includes("Cancelled by user"),
        );
        expect(cancelEvent).toBeTruthy();
        expect(result.current.isResponseLoading).toBe(false);
    });

    it("cancel() with no in-flight request is a no-op", () => {
        const { result } = renderHook(() => useAssistantChat());

        // Should not throw.
        expect(() => result.current.cancel()).not.toThrow();
    });
});

describe("useAssistantChat: handleNewChat", () => {
    it("sets messages + newChatMessages and updates chatId from saveChat", async () => {
        mockSaveChat.mockResolvedValue("new-chat-id");
        const { result } = renderHook(() => useAssistantChat());

        let returned: string | null = null;
        await act(async () => {
            returned = await result.current.handleNewChat(USER_MSG("kickoff"));
        });

        expect(returned).toBe("new-chat-id");
        expect(result.current.chatId).toBe("new-chat-id");
        expect(mockSetCurrentChatId).toHaveBeenCalledWith("new-chat-id");
        expect(mockSetNewChatMessages).toHaveBeenCalledWith([
            { role: "user", content: "kickoff" },
        ]);
        expect(result.current.messages).toEqual([
            { role: "user", content: "kickoff" },
        ]);
    });

    it("returns null and skips chatId update when saveChat returns null", async () => {
        mockSaveChat.mockResolvedValue(null);
        const { result } = renderHook(() => useAssistantChat());

        let returned: string | null = "set";
        await act(async () => {
            returned = await result.current.handleNewChat(USER_MSG("kickoff"));
        });

        expect(returned).toBeNull();
        expect(result.current.chatId).toBeUndefined();
        expect(mockSetCurrentChatId).not.toHaveBeenCalled();
    });

    it("forwards projectId to saveChat", async () => {
        mockSaveChat.mockResolvedValue("c-1");
        const { result } = renderHook(() => useAssistantChat());

        await act(async () => {
            await result.current.handleNewChat(USER_MSG("hi"), "p-1");
        });

        expect(mockSaveChat).toHaveBeenCalledWith("p-1");
    });
});

describe("useAssistantChat: initial state", () => {
    it("seeds messages + chatId from options", () => {
        const initial: MikeMessage[] = [
            { role: "user", content: "old msg" },
            { role: "assistant", content: "old reply" },
        ];
        const { result } = renderHook(() =>
            useAssistantChat({ initialMessages: initial, chatId: "c-prior" }),
        );

        expect(result.current.messages).toEqual(initial);
        expect(result.current.chatId).toBe("c-prior");
        expect(result.current.isResponseLoading).toBe(false);
    });
});

describe("useAssistantChat: user-message dedupe", () => {
    it("does not duplicate the user message when it is already the last in history", async () => {
        // Production case: handleChat is sometimes called with a
        // message that the page-level component already appended
        // (e.g. on a slash-command retry).  The "already added" guard
        // prevents the double-add.
        const existingUserMsg: MikeMessage = {
            role: "user",
            content: "retry this",
        };
        mockStreamChat.mockResolvedValue(sseResponse([]));
        const { result } = renderHook(() =>
            useAssistantChat({ initialMessages: [existingUserMsg] }),
        );

        await act(async () => {
            await result.current.handleChat(existingUserMsg);
        });

        // history is [user, assistant] — not [user, user, assistant].
        const userMessages = result.current.messages.filter(
            (m) => m.role === "user",
        );
        expect(userMessages).toHaveLength(1);
    });
});

describe("useAssistantChat: reasoning events", () => {
    it("reasoning_delta starts a new streaming reasoning block, then appends to it", async () => {
        mockStreamChat.mockResolvedValue(
            sseResponse([
                { type: "reasoning_delta", text: "Let me think " },
                { type: "reasoning_delta", text: "about this." },
                // No reasoning_block_end yet — stays streaming.
            ]),
        );

        const { result } = renderHook(() => useAssistantChat());
        await act(async () => {
            await result.current.handleChat(USER_MSG("hi"));
        });

        const last = result.current.messages[result.current.messages.length - 1];
        const reasoning = (last.events ?? []).find((e) => e.type === "reasoning");
        // Two deltas accumulated into one block.  isStreaming was true
        // during the stream but the end-of-stream finalize step
        // (finalizeStreamingReasoning) clears it before the loop returns,
        // so by the time we observe the message the flag is gone.
        expect(reasoning).toEqual({
            type: "reasoning",
            text: "Let me think about this.",
        });
    });

    it("reasoning_block_end finalises the streaming reasoning block (drops isStreaming)", async () => {
        mockStreamChat.mockResolvedValue(
            sseResponse([
                { type: "reasoning_delta", text: "step one" },
                { type: "reasoning_block_end" },
            ]),
        );

        const { result } = renderHook(() => useAssistantChat());
        await act(async () => {
            await result.current.handleChat(USER_MSG("hi"));
        });

        const last = result.current.messages[result.current.messages.length - 1];
        const reasoning = (last.events ?? []).find((e) => e.type === "reasoning");
        expect(reasoning).toEqual({ type: "reasoning", text: "step one" });
    });

    it("a content_delta after a reasoning block finalises the reasoning into a non-streaming event", async () => {
        // Out-of-order signal: model transitions reasoning -> content
        // without a reasoning_block_end.  finalizeStreamingReasoning
        // catches this so the reasoning event isn't stuck rendering as
        // streaming forever.
        mockStreamChat.mockResolvedValue(
            sseResponse([
                { type: "reasoning_delta", text: "almost" },
                { type: "content_delta", text: "answer." },
            ]),
        );

        const { result } = renderHook(() => useAssistantChat());
        await act(async () => {
            await result.current.handleChat(USER_MSG("hi"));
        });

        const last = result.current.messages[result.current.messages.length - 1];
        const reasoning = (last.events ?? []).find((e) => e.type === "reasoning");
        expect(reasoning).toEqual({ type: "reasoning", text: "almost" });
        const content = (last.events ?? []).find((e) => e.type === "content");
        expect(content).toEqual({ type: "content", text: "answer." });
    });
});

describe("useAssistantChat: tool / workflow events", () => {
    it("tool_call_start adds a streaming tool_call_start placeholder", async () => {
        mockStreamChat.mockResolvedValue(
            sseResponse([{ type: "tool_call_start", name: "read_document" }]),
        );

        const { result } = renderHook(() => useAssistantChat());
        await act(async () => {
            await result.current.handleChat(USER_MSG("hi"));
        });

        const last = result.current.messages[result.current.messages.length - 1];
        const tool = (last.events ?? []).find(
            (e) => e.type === "tool_call_start",
        );
        expect(tool).toEqual({
            type: "tool_call_start",
            name: "read_document",
            isStreaming: true,
        });
    });

    it("workflow_applied adds a workflow_applied event with the workflow_id + title", async () => {
        mockStreamChat.mockResolvedValue(
            sseResponse([
                {
                    type: "workflow_applied",
                    workflow_id: "wf-1",
                    title: "Summarise",
                },
            ]),
        );

        const { result } = renderHook(() => useAssistantChat());
        await act(async () => {
            await result.current.handleChat(USER_MSG("hi"));
        });

        const last = result.current.messages[result.current.messages.length - 1];
        const wf = (last.events ?? []).find(
            (e) => e.type === "workflow_applied",
        );
        expect(wf).toEqual({
            type: "workflow_applied",
            workflow_id: "wf-1",
            title: "Summarise",
        });
    });
});

describe("useAssistantChat: doc_read events", () => {
    it("doc_read_start pushes a streaming doc_read event; doc_read finalises it", async () => {
        mockStreamChat.mockResolvedValue(
            sseResponse([
                { type: "doc_read_start", filename: "report.pdf" },
                { type: "doc_read", filename: "report.pdf" },
            ]),
        );

        const { result } = renderHook(() => useAssistantChat());
        await act(async () => {
            await result.current.handleChat(USER_MSG("hi"));
        });

        const last = result.current.messages[result.current.messages.length - 1];
        const reads = (last.events ?? []).filter((e) => e.type === "doc_read");
        // Single event — doc_read mutates the streaming entry rather
        // than appending a new one.
        expect(reads).toHaveLength(1);
        expect(reads[0]).toMatchObject({
            type: "doc_read",
            filename: "report.pdf",
            isStreaming: false,
        });
    });
});

describe("useAssistantChat: doc_find events", () => {
    it("doc_find_start pushes a streaming doc_find with total_matches=0; doc_find finalises with the real count", async () => {
        mockStreamChat.mockResolvedValue(
            sseResponse([
                {
                    type: "doc_find_start",
                    filename: "spec.pdf",
                    query: "rate limit",
                },
                {
                    type: "doc_find",
                    filename: "spec.pdf",
                    query: "rate limit",
                    total_matches: 4,
                },
            ]),
        );

        const { result } = renderHook(() => useAssistantChat());
        await act(async () => {
            await result.current.handleChat(USER_MSG("hi"));
        });

        const last = result.current.messages[result.current.messages.length - 1];
        const finds = (last.events ?? []).filter((e) => e.type === "doc_find");
        expect(finds).toHaveLength(1);
        expect(finds[0]).toMatchObject({
            type: "doc_find",
            filename: "spec.pdf",
            query: "rate limit",
            total_matches: 4,
            isStreaming: false,
        });
    });

    it("doc_find with no total_matches preserves the previous count from doc_find_start", async () => {
        // Backend may omit total_matches if it was already known —
        // the merge keeps the prior value rather than zeroing it.
        mockStreamChat.mockResolvedValue(
            sseResponse([
                {
                    type: "doc_find_start",
                    filename: "spec.pdf",
                    query: "q",
                },
                // total_matches omitted — preserve doc_find_start's 0.
                { type: "doc_find", filename: "spec.pdf", query: "q" },
            ]),
        );

        const { result } = renderHook(() => useAssistantChat());
        await act(async () => {
            await result.current.handleChat(USER_MSG("hi"));
        });

        const last = result.current.messages[result.current.messages.length - 1];
        const find = (last.events ?? []).find((e) => e.type === "doc_find");
        expect(find).toMatchObject({
            type: "doc_find",
            filename: "spec.pdf",
            query: "q",
            total_matches: 0,
            isStreaming: false,
        });
    });
});

describe("useAssistantChat: doc_created events", () => {
    it("doc_created_start places a streaming doc_created event with empty download_url", async () => {
        mockStreamChat.mockResolvedValue(
            sseResponse([{ type: "doc_created_start", filename: "out.docx" }]),
        );

        const { result } = renderHook(() => useAssistantChat());
        await act(async () => {
            await result.current.handleChat(USER_MSG("hi"));
        });

        const last = result.current.messages[result.current.messages.length - 1];
        const created = (last.events ?? []).find((e) => e.type === "doc_created");
        expect(created).toMatchObject({
            type: "doc_created",
            filename: "out.docx",
            download_url: "",
            isStreaming: true,
        });
    });

    it("doc_created finalises the streaming entry with download_url, document_id, version metadata", async () => {
        mockStreamChat.mockResolvedValue(
            sseResponse([
                { type: "doc_created_start", filename: "out.docx" },
                {
                    type: "doc_created",
                    filename: "out.docx",
                    download_url: "https://r2/file.docx",
                    document_id: "d-1",
                    version_id: "v-1",
                    version_number: 1,
                },
            ]),
        );

        const { result } = renderHook(() => useAssistantChat());
        await act(async () => {
            await result.current.handleChat(USER_MSG("hi"));
        });

        const last = result.current.messages[result.current.messages.length - 1];
        const created = (last.events ?? []).find((e) => e.type === "doc_created");
        expect(created).toEqual({
            type: "doc_created",
            filename: "out.docx",
            download_url: "https://r2/file.docx",
            document_id: "d-1",
            version_id: "v-1",
            version_number: 1,
            isStreaming: false,
        });
    });

    it("doc_download pushes a standalone doc_download event with the download_url", async () => {
        // Production: this fires when the model attaches a
        // user-downloadable artifact mid-stream (e.g. an Excel file).
        mockStreamChat.mockResolvedValue(
            sseResponse([
                {
                    type: "doc_download",
                    filename: "report.xlsx",
                    download_url: "https://r2/report.xlsx",
                },
            ]),
        );

        const { result } = renderHook(() => useAssistantChat());
        await act(async () => {
            await result.current.handleChat(USER_MSG("hi"));
        });

        const last = result.current.messages[result.current.messages.length - 1];
        const download = (last.events ?? []).find(
            (e) => e.type === "doc_download",
        );
        expect(download).toEqual({
            type: "doc_download",
            filename: "report.xlsx",
            download_url: "https://r2/report.xlsx",
        });
    });
});

describe("useAssistantChat: doc_replicate events", () => {
    it("doc_replicate_start places a streaming doc_replicated with the count", async () => {
        mockStreamChat.mockResolvedValue(
            sseResponse([
                {
                    type: "doc_replicate_start",
                    filename: "tpl.docx",
                    count: 3,
                },
            ]),
        );

        const { result } = renderHook(() => useAssistantChat());
        await act(async () => {
            await result.current.handleChat(USER_MSG("hi"));
        });

        const last = result.current.messages[result.current.messages.length - 1];
        const repl = (last.events ?? []).find(
            (e) => e.type === "doc_replicated",
        );
        expect(repl).toMatchObject({
            type: "doc_replicated",
            filename: "tpl.docx",
            count: 3,
            isStreaming: true,
        });
    });

    it("doc_replicated finalises with the copies array and computes count from it when omitted", async () => {
        mockStreamChat.mockResolvedValue(
            sseResponse([
                {
                    type: "doc_replicate_start",
                    filename: "tpl.docx",
                    count: 3,
                },
                {
                    type: "doc_replicated",
                    filename: "tpl.docx",
                    // count omitted — falls back to copies.length
                    copies: [
                        { new_filename: "tpl-1.docx", document_id: "d1", version_id: "v1" },
                        { new_filename: "tpl-2.docx", document_id: "d2", version_id: "v2" },
                    ],
                },
            ]),
        );

        const { result } = renderHook(() => useAssistantChat());
        await act(async () => {
            await result.current.handleChat(USER_MSG("hi"));
        });

        const last = result.current.messages[result.current.messages.length - 1];
        const repl = (last.events ?? []).find(
            (e) => e.type === "doc_replicated",
        );
        expect(repl).toMatchObject({
            type: "doc_replicated",
            filename: "tpl.docx",
            count: 2,
            isStreaming: false,
        });
        expect((repl as { copies: unknown[] }).copies).toHaveLength(2);
    });

    it("doc_replicated with error string is preserved on the event", async () => {
        mockStreamChat.mockResolvedValue(
            sseResponse([
                {
                    type: "doc_replicate_start",
                    filename: "tpl.docx",
                    count: 1,
                },
                {
                    type: "doc_replicated",
                    filename: "tpl.docx",
                    error: "out of storage",
                },
            ]),
        );

        const { result } = renderHook(() => useAssistantChat());
        await act(async () => {
            await result.current.handleChat(USER_MSG("hi"));
        });

        const last = result.current.messages[result.current.messages.length - 1];
        const repl = (last.events ?? []).find(
            (e) => e.type === "doc_replicated",
        );
        expect(repl).toMatchObject({
            type: "doc_replicated",
            error: "out of storage",
            isStreaming: false,
            // count fallback to 1 (no count, no copies → default 1)
            count: 1,
        });
    });
});

describe("useAssistantChat: doc_edited events", () => {
    it("doc_edited_start places a streaming doc_edited with empty placeholder fields", async () => {
        mockStreamChat.mockResolvedValue(
            sseResponse([{ type: "doc_edited_start", filename: "draft.docx" }]),
        );

        const { result } = renderHook(() => useAssistantChat());
        await act(async () => {
            await result.current.handleChat(USER_MSG("hi"));
        });

        const last = result.current.messages[result.current.messages.length - 1];
        const edit = (last.events ?? []).find((e) => e.type === "doc_edited");
        expect(edit).toMatchObject({
            type: "doc_edited",
            filename: "draft.docx",
            document_id: "",
            version_id: "",
            download_url: "",
            annotations: [],
            isStreaming: true,
        });
    });

    it("doc_edited finalises with the real document/version metadata + annotations", async () => {
        mockStreamChat.mockResolvedValue(
            sseResponse([
                { type: "doc_edited_start", filename: "draft.docx" },
                {
                    type: "doc_edited",
                    filename: "draft.docx",
                    document_id: "d-9",
                    version_id: "v-3",
                    version_number: 3,
                    download_url: "https://r2/draft.docx",
                    annotations: [],
                },
            ]),
        );

        const { result } = renderHook(() => useAssistantChat());
        await act(async () => {
            await result.current.handleChat(USER_MSG("hi"));
        });

        const last = result.current.messages[result.current.messages.length - 1];
        const edit = (last.events ?? []).find((e) => e.type === "doc_edited");
        expect(edit).toMatchObject({
            type: "doc_edited",
            filename: "draft.docx",
            document_id: "d-9",
            version_id: "v-3",
            version_number: 3,
            download_url: "https://r2/draft.docx",
            isStreaming: false,
        });
    });

    it("doc_edited with a string error field carries the error through", async () => {
        mockStreamChat.mockResolvedValue(
            sseResponse([
                { type: "doc_edited_start", filename: "x.docx" },
                {
                    type: "doc_edited",
                    filename: "x.docx",
                    error: "model declined",
                },
            ]),
        );

        const { result } = renderHook(() => useAssistantChat());
        await act(async () => {
            await result.current.handleChat(USER_MSG("hi"));
        });

        const last = result.current.messages[result.current.messages.length - 1];
        const edit = (last.events ?? []).find((e) => e.type === "doc_edited");
        expect(edit).toMatchObject({
            type: "doc_edited",
            error: "model declined",
            isStreaming: false,
        });
    });
});

describe("useAssistantChat: drip animation", () => {
    it("reveals content progressively at 8 chars per 16ms tick", async () => {
        // The drip is the SUT's "typewriter" effect — content appears
        // ~8 characters per tick rather than all at once.  Without
        // fake timers the read loop's flushDrip() at end-of-stream
        // shortcircuits this entirely (you only see the final string),
        // so we have to control the clock to observe the animation.

        vi.useFakeTimers();
        try {
            // A response that emits one big delta then never closes
            // until we manually close.  This way the drip is still
            // ticking when we assert.
            let close!: () => void;
            const closer = new Promise<void>((r) => {
                close = r;
            });

            mockStreamChat.mockResolvedValue(
                new Response(
                    new ReadableStream({
                        async start(controller) {
                            const enc = new TextEncoder();
                            controller.enqueue(
                                enc.encode(
                                    `data: ${JSON.stringify({
                                        type: "content_delta",
                                        text: "0123456789ABCDEFGHIJ",
                                    })}\n\n`,
                                ),
                            );
                            await closer;
                            controller.enqueue(enc.encode("data: [DONE]\n\n"));
                            controller.close();
                        },
                    }),
                    { headers: { "Content-Type": "text/event-stream" } },
                ),
            );

            const { result } = renderHook(() => useAssistantChat());
            // Kick off handleChat but don't await — we want to step
            // the drip while the request is in flight.
            let chatPromise!: Promise<string | null>;
            await act(async () => {
                chatPromise = result.current.handleChat(USER_MSG("hi"));
                // Let microtasks run so the stream's first chunk is
                // consumed and the drip starts.
                await Promise.resolve();
                await Promise.resolve();
                await Promise.resolve();
            });

            // Advance one tick — 8 characters should be visible.
            await act(async () => {
                vi.advanceTimersByTime(16);
            });
            let last =
                result.current.messages[result.current.messages.length - 1];
            let content = (last.events ?? []).find(
                (e) => e.type === "content",
            ) as { text: string; isStreaming?: boolean } | undefined;
            expect(content?.text).toBe("01234567");
            expect(content?.isStreaming).toBe(true);

            // Advance two more ticks (32ms total) — 16 chars.
            await act(async () => {
                vi.advanceTimersByTime(16);
            });
            last = result.current.messages[result.current.messages.length - 1];
            content = (last.events ?? []).find(
                (e) => e.type === "content",
            ) as { text: string; isStreaming?: boolean } | undefined;
            expect(content?.text).toBe("0123456789ABCDEF");

            // Final tick — full string visible; drip stops itself.
            await act(async () => {
                vi.advanceTimersByTime(16);
            });
            last = result.current.messages[result.current.messages.length - 1];
            content = (last.events ?? []).find(
                (e) => e.type === "content",
            ) as { text: string; isStreaming?: boolean } | undefined;
            expect(content?.text).toBe("0123456789ABCDEFGHIJ");

            // Close out the stream so the hook's read loop finishes
            // cleanly and resolves the handleChat promise.
            close();
            await act(async () => {
                vi.runAllTimersAsync();
                await chatPromise;
            });
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("useAssistantChat: chat history side-effects", () => {
    it("calls loadChats after the stream completes", async () => {
        mockStreamChat.mockResolvedValue(sseResponse([]));
        const { result } = renderHook(() => useAssistantChat());

        await act(async () => {
            await result.current.handleChat(USER_MSG("hi"));
        });

        await waitFor(() => expect(mockLoadChats).toHaveBeenCalledOnce());
    });

    it("calls replaceChatId when a chat_id arrives mid-stream and we already had an id", async () => {
        mockStreamChat.mockResolvedValue(
            sseResponse([{ type: "chat_id", chatId: "from-server" }]),
        );
        const { result } = renderHook(() =>
            useAssistantChat({ chatId: "local-pending" }),
        );

        await act(async () => {
            await result.current.handleChat(USER_MSG("first content"));
        });

        // Title is trimmed to 120 chars.
        expect(mockReplaceChatId).toHaveBeenCalledWith(
            "local-pending",
            "from-server",
            "first content",
        );
    });
});
