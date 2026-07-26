import { forwardRef } from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import ProjectAssistantChatClient from "@/app/(pages)/projects/[id]/assistant/chat/[chatId]/ProjectAssistantChatClient";

const { getChatSkillBindingMock, upgradeChatSkillMock } = vi.hoisted(() => ({
    getChatSkillBindingMock: vi.fn(),
    upgradeChatSkillMock: vi.fn(),
}));

vi.mock("@/altien/skillRuntime/api", () => ({
    getChatSkillBinding: getChatSkillBindingMock,
    upgradeChatSkill: upgradeChatSkillMock,
}));

vi.mock("next/navigation", () => ({
    usePathname: () => "/projects/project-1/assistant/chat/chat-1",
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
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

vi.mock("@/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: { displayName: "Tester" } }),
}));

vi.mock("@/app/lib/mikeApi", () => ({
    getChat: vi.fn().mockResolvedValue({
        chat: { id: "chat-1", title: "Skill run", user_id: "user-1" },
        messages: [],
        skillBinding: {
            skillId: "skill-1",
            versionId: "version-1",
            displayName: "Citation Reader",
            contentHash: "aaaaaaaabbbbbbbb",
            dependencyVersions: [],
        },
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
    AuthorityTracePanel: () => null,
}));

vi.mock("@/app/components/assistant/ChatInput", () => ({
    ChatInput: forwardRef(() => <div>Chat input</div>),
}));

vi.mock("@/components/chat/mike-icon", () => ({
    MikeIcon: () => <span>Mike</span>,
}));

beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
    getChatSkillBindingMock.mockReset();
    upgradeChatSkillMock.mockReset();
});

describe("explicit chat skill upgrade", () => {
    it("offers the upgrade and applies it only when the member clicks", async () => {
        getChatSkillBindingMock.mockResolvedValue({
            binding: {
                skillId: "skill-1",
                versionId: "version-1",
                displayName: "Citation Reader",
                contentHash: "aaaaaaaabbbbbbbb",
                dependencyVersions: [],
                selectedDocumentIds: [],
                availableUpgrade: {
                    versionId: "version-2",
                    contentHash: "ccccccccdddddddd",
                },
            },
        });
        upgradeChatSkillMock.mockResolvedValue({
            chatId: "chat-1",
            skillId: "skill-1",
            displayName: "Citation Reader",
            previousVersionId: "version-1",
            versionId: "version-2",
            contentHash: "ccccccccdddddddd",
        });

        renderWithProviders(<ProjectAssistantChatClient />, {
            user: { id: "user-1", email: "tester@example.com" },
        });

        const upgrade = await screen.findByRole("button", { name: /Upgrade/ });
        expect(
            screen.getByText(/has a newer approved version/),
        ).toBeInTheDocument();
        // Reading the binding must never upgrade by itself.
        expect(upgradeChatSkillMock).not.toHaveBeenCalled();

        fireEvent.click(upgrade);

        expect(upgradeChatSkillMock).toHaveBeenCalledWith(
            "project-1",
            "chat-1",
            "version-2",
        );
        // The banner clears and the visible version badge follows the rebind.
        await waitFor(() =>
            expect(
                screen.queryByRole("button", { name: /Upgrade/ }),
            ).not.toBeInTheDocument(),
        );
        expect(
            screen.getByTitle("Skill version version-2; content ccccccccdddddddd"),
        ).toBeInTheDocument();
    });

    it("shows no upgrade control when the chat runs the current version", async () => {
        getChatSkillBindingMock.mockResolvedValue({
            binding: {
                skillId: "skill-1",
                versionId: "version-1",
                displayName: "Citation Reader",
                contentHash: "aaaaaaaabbbbbbbb",
                dependencyVersions: [],
                selectedDocumentIds: [],
                availableUpgrade: null,
            },
        });

        renderWithProviders(<ProjectAssistantChatClient />, {
            user: { id: "user-1", email: "tester@example.com" },
        });

        expect(await screen.findByText(/Skill: Citation Reader/)).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: /Upgrade/ }),
        ).not.toBeInTheDocument();
    });
});
