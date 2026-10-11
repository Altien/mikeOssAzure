/**
 * The sidebar history follows the active workspace. A switch re-reads the
 * first page, and the previous workspace's chats must neither linger on
 * screen nor land on top of the new list when their slower answer arrives.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listChats = vi.fn();
const workspace = vi.hoisted(() => ({
    current: "personal" as string | undefined,
}));
const STABLE_USER = vi.hoisted(() => ({ id: "u1", email: "u1@example.com" }));

vi.mock("@/app/lib/mikeApi", () => ({
    createChat: vi.fn(),
    listChats: (...args: unknown[]) => listChats(...args),
    renameChat: vi.fn(),
    deleteChat: vi.fn(async () => undefined),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: STABLE_USER }),
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
    useWorkspaceParam: () => workspace.current,
}));

import {
    ChatHistoryProvider,
    useChatHistoryContext,
} from "./ChatHistoryContext";

const chat = (id: string, title: string) => ({
    id,
    title,
    user_id: "u1",
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    is_owner: true,
});

function Probe() {
    const { chats } = useChatHistoryContext();
    return (
        <p>
            {chats === null
                ? "loading"
                : chats.map((item) => item.title).join(",") || "empty"}
        </p>
    );
}

const tree = () => (
    <ChatHistoryProvider>
        <Probe />
    </ChatHistoryProvider>
);

beforeEach(() => {
    vi.clearAllMocks();
    workspace.current = "personal";
});

describe("ChatHistoryProvider and the active workspace", () => {
    it("asks for the active workspace's chats", async () => {
        listChats.mockResolvedValue([chat("c1", "Personal note")]);
        render(tree());

        await screen.findByText("Personal note");
        expect(listChats).toHaveBeenCalledWith(
            expect.objectContaining({ workspace: "personal" }),
        );
    });

    it("clears the list and reloads when the workspace changes", async () => {
        let resolveOrg!: (rows: unknown[]) => void;
        listChats.mockImplementation((options: { workspace?: string }) =>
            options.workspace === "org-1"
                ? new Promise((resolve) => {
                      resolveOrg = resolve;
                  })
                : Promise.resolve([chat("c1", "Personal note")]),
        );
        const { rerender } = render(tree());
        await screen.findByText("Personal note");

        workspace.current = "org-1";
        rerender(tree());

        // The personal chats leave the screen while the firm's are loading:
        // a list that still shows them would be naming the wrong workspace.
        await screen.findByText("loading");
        expect(screen.queryByText("Personal note")).not.toBeInTheDocument();

        await act(async () => resolveOrg([chat("c2", "Firm matter")]));
        await screen.findByText("Firm matter");
        expect(listChats).toHaveBeenLastCalledWith(
            expect.objectContaining({ workspace: "org-1" }),
        );
    });

    it("drops a previous workspace's answer that arrives after the switch", async () => {
        let resolvePersonal!: (rows: unknown[]) => void;
        listChats.mockImplementation((options: { workspace?: string }) =>
            options.workspace === "org-1"
                ? Promise.resolve([chat("c2", "Firm matter")])
                : new Promise((resolve) => {
                      resolvePersonal = resolve;
                  }),
        );
        const { rerender } = render(tree());
        await waitFor(() => expect(listChats).toHaveBeenCalledTimes(1));

        workspace.current = "org-1";
        rerender(tree());
        await screen.findByText("Firm matter");

        await act(async () => resolvePersonal([chat("c1", "Personal note")]));
        expect(screen.getByText("Firm matter")).toBeInTheDocument();
        expect(screen.queryByText("Personal note")).not.toBeInTheDocument();
    });
});
