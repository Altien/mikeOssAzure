import { forwardRef } from "react";
import { fireEvent, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import type { Message } from "@/app/components/shared/types";
import ProjectAssistantChatClient from "@/app/(pages)/projects/[id]/assistant/chat/[chatId]/ProjectAssistantChatClient";

const { authorityTraceMessage } = vi.hoisted(() => ({
    authorityTraceMessage: {
        role: "assistant",
        content: "",
        events: [
            {
                type: "authority_trace_verification",
                run_id: "run-1",
                outcome: "success",
                total: 1,
                anchored: 1,
                failed: 0,
                exact: 1,
                formatting_different: 0,
                no_quote_claimed: 0,
                warning_count: 0,
            },
        ],
    } as Message,
}));

vi.mock("next/navigation", () => ({
    usePathname: () => "/projects/project-1/assistant/chat/chat-1",
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/app/hooks/useAssistantChat", () => ({
    useAssistantChat: () => ({
        messages: [authorityTraceMessage],
        isResponseLoading: false,
        handleChat: vi.fn(),
        setMessages: vi.fn(),
        cancel: vi.fn(),
    }),
}));

vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        setCurrentChatId: vi.fn(),
        newChatMessages: null,
        setNewChatMessages: vi.fn(),
        chats: [],
        saveChat: vi.fn(),
    }),
}));

vi.mock("@/app/contexts/SidebarContext", () => ({
    useSidebar: () => ({ setSidebarOpen: vi.fn() }),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: { displayName: "Tester" } }),
}));

vi.mock("@/app/lib/mikeApi", () => ({
    getChat: vi.fn().mockResolvedValue({
        chat: { id: "chat-1", title: "Trace", user_id: "user-1" },
        messages: [authorityTraceMessage],
    }),
    getProject: vi.fn().mockResolvedValue({
        id: "project-1",
        name: "Test project",
        documents: [],
        folders: [],
    }),
    deleteChat: vi.fn(),
    deleteDocument: vi.fn(),
    uploadProjectDocument: vi.fn(),
    createProjectFolder: vi.fn(),
    renameProjectFolder: vi.fn(),
    deleteProjectFolder: vi.fn(),
    moveDocumentToFolder: vi.fn(),
    moveSubfolderToFolder: vi.fn(),
}));

vi.mock("@/app/components/projects/ProjectExplorer", () => ({
    ProjectExplorer: () => <div>Project explorer</div>,
}));

vi.mock("@/app/components/shared/DocView", () => ({
    DocView: () => <div>Document view</div>,
}));

vi.mock("@/app/components/shared/DocxView", () => ({
    DocxView: () => <div>Word view</div>,
}));

vi.mock("@/app/components/shared/OwnerOnlyModal", () => ({
    OwnerOnlyModal: () => null,
}));

vi.mock("@/altien/authorityTrace/AuthorityTracePanel", () => ({
    AuthorityTracePanel: ({ runId }: { runId: string }) => (
        <div>Reviewing Authority Trace {runId}</div>
    ),
}));

vi.mock("@/app/components/assistant/ChatInput", () => ({
    ChatInput: forwardRef(() => <div>Chat input</div>),
}));

vi.mock("@/app/components/chat/mike-icon", () => ({
    MikeIcon: () => <span>Mike</span>,
}));

beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
});

describe("ProjectAssistantChatClient Authority Trace", () => {
    it("opens a persisted run in the project viewer", async () => {
        renderWithProviders(<ProjectAssistantChatClient />, {
            user: { id: "user-1", email: "tester@example.com" },
        });

        fireEvent.click(
            await screen.findByRole("button", {
                name: /Authority Trace completed/,
            }),
        );

        expect(
            await screen.findByText("Reviewing Authority Trace run-1"),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Close Authority Trace" }),
        ).toBeInTheDocument();
    });
});
