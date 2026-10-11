import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import {
    PERSONAL_WORKSPACE,
    WorkspaceProvider,
    useWorkspace,
    useWorkspaceParam,
} from "./WorkspaceContext";

const mocks = vi.hoisted(() => ({
    userId: "u1" as string | null,
    listOrgs: vi.fn(),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: mocks.userId ? { id: mocks.userId } : null }),
}));
vi.mock("@/app/lib/mikeApi", () => ({ listOrgs: mocks.listOrgs }));

const ACME = { id: "org-acme", name: "Acme LLP", role: "member" };
const BETA = { id: "org-beta", name: "Beta Chambers", role: "owner" };
const STORAGE_KEY = "mike.activeWorkspace.u1";

// The context value as of the last commit, so a test can call its actions.
// Published from an effect: render must not write to module state.
let latest: ReturnType<typeof useWorkspace>;
function Probe() {
    const value = useWorkspace();
    useEffect(() => {
        latest = value;
    });
    const param = useWorkspaceParam();
    return (
        <p>
            {value.workspaceId}|{param ?? "unscoped"}|
            {value.organizations === null ? "loading" : "loaded"}|
            {value.activeOrganization?.name ?? "none"}
        </p>
    );
}

function renderProvider() {
    return render(
        <WorkspaceProvider>
            <Probe />
        </WorkspaceProvider>,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mocks.userId = "u1";
    mocks.listOrgs.mockResolvedValue([ACME, BETA]);
});

describe("WorkspaceProvider", () => {
    it("starts in the personal workspace", async () => {
        renderProvider();
        expect(screen.getByText(/^personal\|personal\|loading/)).toBeInTheDocument();
        await screen.findByText("personal|personal|loaded|none");
    });

    it("restores the workspace this account last used, before the organizations load", async () => {
        // Asking for Personal first and the organization a moment later would
        // paint the wrong workspace's lists on every reload.
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        renderProvider();
        expect(
            screen.getByText(`${ACME.id}|${ACME.id}|loading|none`),
        ).toBeInTheDocument();
        await screen.findByText(`${ACME.id}|${ACME.id}|loaded|Acme LLP`);
    });

    it("falls back to Personal when the remembered organization is gone", async () => {
        window.localStorage.setItem(STORAGE_KEY, "org-left");
        renderProvider();
        await screen.findByText("personal|personal|loaded|none");
        await waitFor(() =>
            expect(window.localStorage.getItem(STORAGE_KEY)).toBe(
                PERSONAL_WORKSPACE,
            ),
        );
    });

    it("keeps the remembered organization when the organizations cannot be read", async () => {
        // A failed read is not evidence that the person left their firm.
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        mocks.listOrgs.mockRejectedValue(new Error("network"));
        renderProvider();
        await waitFor(() => expect(mocks.listOrgs).toHaveBeenCalled());
        expect(
            screen.getByText(`${ACME.id}|${ACME.id}|loading|none`),
        ).toBeInTheDocument();
        expect(window.localStorage.getItem(STORAGE_KEY)).toBe(ACME.id);
    });

    it("switches workspace and remembers the choice for this account", async () => {
        renderProvider();
        await screen.findByText("personal|personal|loaded|none");

        act(() => latest.setWorkspace(BETA.id));
        await screen.findByText(`${BETA.id}|${BETA.id}|loaded|Beta Chambers`);
        expect(window.localStorage.getItem(STORAGE_KEY)).toBe(BETA.id);

        act(() => latest.setWorkspace(PERSONAL_WORKSPACE));
        await screen.findByText("personal|personal|loaded|none");
        expect(window.localStorage.getItem(STORAGE_KEY)).toBe(
            PERSONAL_WORKSPACE,
        );
    });

    it("ignores a workspace the caller does not belong to", async () => {
        renderProvider();
        await screen.findByText("personal|personal|loaded|none");
        act(() => latest.setWorkspace("org-stranger"));
        expect(
            screen.getByText("personal|personal|loaded|none"),
        ).toBeInTheDocument();
    });

    it("moves to Personal when a refresh shows the active organization was left", async () => {
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        renderProvider();
        await screen.findByText(`${ACME.id}|${ACME.id}|loaded|Acme LLP`);

        mocks.listOrgs.mockResolvedValue([BETA]);
        await act(() => latest.refreshOrganizations());
        await screen.findByText("personal|personal|loaded|none");

        // Being invited back later must not silently move them again.
        mocks.listOrgs.mockResolvedValue([ACME, BETA]);
        await act(() => latest.refreshOrganizations());
        expect(
            screen.getByText("personal|personal|loaded|none"),
        ).toBeInTheDocument();
    });

    it("re-reads the organizations when the tab becomes visible again", async () => {
        renderProvider();
        await screen.findByText("personal|personal|loaded|none");
        expect(mocks.listOrgs).toHaveBeenCalledTimes(1);

        act(() => {
            document.dispatchEvent(new Event("visibilitychange"));
        });
        await waitFor(() => expect(mocks.listOrgs).toHaveBeenCalledTimes(2));
    });

    it("keeps each account's remembered workspace separate", async () => {
        window.localStorage.setItem("mike.activeWorkspace.u2", BETA.id);
        mocks.userId = "u2";
        renderProvider();
        await screen.findByText(`${BETA.id}|${BETA.id}|loaded|Beta Chambers`);
        expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    });
});

describe("outside a WorkspaceProvider", () => {
    it("does not narrow lists at all", () => {
        // Surfaces that render without the app shell keep listing everything,
        // as they did before workspaces existed.
        render(<Probe />);
        expect(screen.getByText("|unscoped|loading|none")).toBeInTheDocument();
    });
});
