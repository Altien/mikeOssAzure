import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const { mockGenerateChatTitle, mockRenameChat } = vi.hoisted(() => ({
    mockGenerateChatTitle: vi.fn(),
    mockRenameChat: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", () => ({
    generateChatTitle: mockGenerateChatTitle,
}));

vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        renameChat: mockRenameChat,
    }),
}));

import { useGenerateChatTitle } from "./useGenerateChatTitle";

beforeEach(() => {
    mockGenerateChatTitle.mockReset();
    mockRenameChat.mockReset();
});

describe("useGenerateChatTitle: happy path", () => {
    it("calls generateChatTitle then renameChat with the returned title", async () => {
        mockGenerateChatTitle.mockResolvedValue({ title: "Fresh title" });
        mockRenameChat.mockResolvedValue(undefined);
        const { result } = renderHook(() => useGenerateChatTitle());

        await act(async () => {
            await result.current.generate("chat-1", "user message");
        });

        expect(mockGenerateChatTitle).toHaveBeenCalledWith("chat-1", "user message");
        expect(mockRenameChat).toHaveBeenCalledWith("chat-1", "Fresh title");
    });
});

describe("useGenerateChatTitle: best-effort error swallow", () => {
    it("does not throw when generateChatTitle rejects", async () => {
        // Title generation is incidental — a failure must not break
        // the chat.  The catch block intentionally swallows.
        mockGenerateChatTitle.mockRejectedValue(new Error("title API down"));
        const { result } = renderHook(() => useGenerateChatTitle());

        await act(async () => {
            await expect(
                result.current.generate("chat-x", "hello"),
            ).resolves.toBeUndefined();
        });

        // renameChat must NOT have been called — without a title there
        // is nothing to rename to.
        expect(mockRenameChat).not.toHaveBeenCalled();
    });

    it("does not throw when renameChat rejects", async () => {
        mockGenerateChatTitle.mockResolvedValue({ title: "T" });
        mockRenameChat.mockRejectedValue(new Error("db locked"));
        const { result } = renderHook(() => useGenerateChatTitle());

        await act(async () => {
            await expect(
                result.current.generate("chat-y", "hello"),
            ).resolves.toBeUndefined();
        });

        // Both calls fired, but no exception propagated.
        expect(mockGenerateChatTitle).toHaveBeenCalledOnce();
        expect(mockRenameChat).toHaveBeenCalledOnce();
    });
});

describe("useGenerateChatTitle: setter stability", () => {
    it("returns the same generate function across renders when renameChat is stable", () => {
        const { result, rerender } = renderHook(() => useGenerateChatTitle());
        const first = result.current.generate;

        rerender();

        // useCallback deps on renameChat — the mocked context returns
        // the same renameChat ref, so generate is stable too.
        expect(result.current.generate).toBe(first);
    });
});
