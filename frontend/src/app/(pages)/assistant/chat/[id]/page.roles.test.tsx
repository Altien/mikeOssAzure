import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Grant-reachable chats appear in the global sidebar since the parity
// change, so a project viewer can land on this page. GET /chat/:id serves
// the caller's standing; this file pins that the page actually consumes it
// — dropping it handed a viewer a live composer whose sends 403.

const { getChat } = vi.hoisted(() => ({ getChat: vi.fn() }));

vi.mock("next/navigation", () => ({
    useParams: () => ({ id: "chat-1" }),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/app/lib/mikeApi", () => ({
    getChat: (...args: unknown[]) => getChat(...args),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        setCurrentChatId: vi.fn(),
        newChatMessages: null,
        setNewChatMessages: vi.fn(),
    }),
}));
vi.mock("@/app/hooks/useAssistantChat", () => ({
    useAssistantChat: () => ({
        messages: [],
        isResponseLoading: false,
        handleChat: vi.fn(),
        setMessages: vi.fn(),
        cancel: vi.fn(),
    }),
}));
vi.mock("@/app/components/assistant/ChatView", () => ({
    ChatView: ({
        canSend,
        chat,
    }: {
        canSend?: boolean;
        chat?: { access_role?: string } | null;
    }) => (
        <>
            <span data-testid="can-send">{String(canSend)}</span>
            <span data-testid="chat-role">{chat?.access_role ?? "unknown"}</span>
        </>
    ),
}));

import AssistantChatPage from "./page";

function chatDetail(access_role: "owner" | "editor" | "viewer") {
    return {
        chat: {
            id: "chat-1",
            title: "Quarterly filing",
            model: null,
            reasoning_level: null,
            is_owner: false,
            access_role,
        },
        messages: [{ id: "m1", role: "user", content: "hi" }],
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("global chat page composer gating", () => {
    it("hands a project viewer a read-only composer", async () => {
        getChat.mockResolvedValue(chatDetail("viewer"));
        render(<AssistantChatPage />);
        await waitFor(() =>
            expect(screen.getByTestId("can-send")).toHaveTextContent("false"),
        );
        expect(screen.getByTestId("chat-role")).toHaveTextContent("viewer");
    });

    it("keeps the composer live for a role the server lets write", async () => {
        getChat.mockResolvedValue(chatDetail("editor"));
        render(<AssistantChatPage />);
        await waitFor(() =>
            expect(screen.getByTestId("can-send")).toHaveTextContent("true"),
        );
        expect(screen.getByTestId("chat-role")).toHaveTextContent("editor");
    });
});
