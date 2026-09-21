import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { beginAssistantTurn } from "@/app/lib/assistantTurns";
import { useAssistantHistoryStatuses } from "./useAssistantHistoryStatuses";

describe("useAssistantHistoryStatuses", () => {
    it("tracks loading and detached completion and clears a selected chat", async () => {
        const onActivity = vi.fn();
        const { result, rerender } = renderHook(
            ({ activeChatId }) =>
                useAssistantHistoryStatuses({
                    activeChatId,
                    chatIds: ["chat-1", "chat-2"],
                    onActivity,
                }),
            { initialProps: { activeChatId: "chat-1" as string | null } },
        );
        let turn!: ReturnType<typeof beginAssistantTurn>;
        act(() => {
            turn = beginAssistantTurn("chat-1", {
                userMessage: { role: "user", content: "Question" },
                assistant: { role: "assistant", content: "" },
                cancel: vi.fn(),
            });
        });

        await waitFor(() =>
            expect(result.current.statuses["chat-1"]).toBe("loading"),
        );
        rerender({ activeChatId: "chat-2" });
        act(() => turn.finish());
        await waitFor(() =>
            expect(result.current.statuses["chat-1"]).toBe("complete"),
        );
        expect(onActivity).toHaveBeenCalledWith("chat-1");

        rerender({ activeChatId: "chat-1" });
        await waitFor(() =>
            expect(result.current.statuses["chat-1"]).toBeUndefined(),
        );
    });
});
