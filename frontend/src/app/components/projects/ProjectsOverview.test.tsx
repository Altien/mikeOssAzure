import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectsOverview } from "./ProjectsOverview";

const { activeTab, setActiveTab, usePaginatedProjectsSpy } = vi.hoisted(() => ({
    activeTab: { current: "all" as string },
    setActiveTab: vi.fn(),
    usePaginatedProjectsSpy: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => ({ get: () => null }),
}));

vi.mock("@/app/hooks/useQueryParamTab", () => ({
    useQueryParamTab: (tabs: string[], defaultTab: string) => [
        tabs.includes(activeTab.current) ? activeTab.current : defaultTab,
        setActiveTab,
    ],
}));

vi.mock("@/app/hooks/usePaginatedProjects", () => ({
    usePaginatedProjects: (options: unknown) => {
        usePaginatedProjectsSpy(options);
        return {
            projects: [],
            setProjects: vi.fn(),
            loading: false,
            loadingMore: false,
            hasMore: false,
            error: null,
            loadMoreError: null,
            loadMore: vi.fn(),
            retry: vi.fn(),
            selectedProjectIds: [],
            setSelectedProjectIds: vi.fn(),
            selectAllMatching: vi.fn(),
            getProjectOwnerId: vi.fn(),
        };
    },
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({
        user: { id: "user-1" },
        isAuthenticated: true,
        authLoading: false,
    }),
}));

vi.mock("@/app/lib/mikeApi", () => ({
    getProjectFilterOptions: vi.fn(() => new Promise(() => {})),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
}));

vi.mock("./NewProjectModal", () => ({ NewProjectModal: () => null }));
vi.mock("./ProjectDetailsModal", () => ({ ProjectDetailsModal: () => null }));

function lastScope() {
    const calls = usePaginatedProjectsSpy.mock.calls;
    return (calls[calls.length - 1][0] as { scope: string }).scope;
}

describe("ProjectsOverview tabs", () => {
    beforeEach(() => {
        activeTab.current = "all";
        setActiveTab.mockReset();
        usePaginatedProjectsSpy.mockReset();
        vi.stubGlobal(
            "matchMedia",
            vi.fn().mockReturnValue({
                matches: true,
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
            }),
        );
    });

    it("shows All first and defaults to it", () => {
        activeTab.current = "unknown";
        render(<ProjectsOverview />);

        const tabs = ["All", "Shared", "Private"].map((label) =>
            screen.getByRole("button", { name: label }),
        );
        expect(tabs[0].compareDocumentPosition(tabs[1])).toBe(
            Node.DOCUMENT_POSITION_FOLLOWING,
        );
        expect(tabs[1].compareDocumentPosition(tabs[2])).toBe(
            Node.DOCUMENT_POSITION_FOLLOWING,
        );
        expect(lastScope()).toBe("all");
    });

    it("selects the All tab", async () => {
        const user = userEvent.setup();
        activeTab.current = "private";
        render(<ProjectsOverview />);

        await user.click(screen.getByRole("button", { name: "All" }));

        expect(setActiveTab).toHaveBeenCalledWith("all");
    });

    it("maps each tab to its backend scope", () => {
        activeTab.current = "shared";
        const shared = render(<ProjectsOverview />);
        expect(lastScope()).toBe("collaborative");
        shared.unmount();

        activeTab.current = "private";
        render(<ProjectsOverview />);
        expect(lastScope()).toBe("private");
    });

    it("offers project creation when All is empty", () => {
        render(<ProjectsOverview />);

        expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
        expect(screen.queryByText(/No all projects/i)).not.toBeInTheDocument();
    });
});
