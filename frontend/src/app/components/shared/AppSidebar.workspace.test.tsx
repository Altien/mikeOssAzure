import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listProjectSummaries } from "@/app/lib/mikeApi";
import { AppSidebar } from "./AppSidebar";

type Org = { id: string; name: string; role: "owner" | "admin" | "member" };

const ACME: Org = { id: "org-acme", name: "Acme LLP", role: "member" };
const BETA: Org = { id: "org-beta", name: "Beta Chambers", role: "owner" };

const state = vi.hoisted(() => ({
  workspaceId: "personal" as string | null,
  organizations: [] as Org[] | null,
  setWorkspace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/assistant",
}));

vi.mock("next/image", () => ({
  default: ({ className }: { className?: string }) => (
    <span aria-hidden="true" className={className} />
  ),
}));

vi.mock("@/app/lib/mikeApi", () => ({
  listProjectSummaries: vi.fn(),
  listProjectChats: vi.fn(async () => []),
  listTabularReviews: vi.fn(async () => []),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "workspace-user", email: "alice@example.com" },
    signOut: vi.fn(),
  }),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
  useUserProfile: () => ({ profile: { displayName: "Alice", tier: "Free" } }),
}));

vi.mock("@/app/contexts/ChatHistoryContext", () => ({
  useChatHistoryContext: () => ({
    chats: [],
    loadingMoreChats: false,
    loadMoreChats: vi.fn(),
    setCurrentChatId: vi.fn(),
  }),
}));

vi.mock("@/app/contexts/WorkspaceContext", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/app/contexts/WorkspaceContext")
  >()),
  useWorkspace: () => ({
    workspaceId: state.workspaceId,
    organizations: state.organizations,
    activeOrganization:
      state.organizations?.find((org) => org.id === state.workspaceId) ?? null,
    setWorkspace: state.setWorkspace,
    refreshOrganizations: vi.fn(),
  }),
}));

vi.mock("@/shared/ui/MikeIconUI", () => ({
  MikeIcon: () => <span aria-hidden="true" />,
}));

const project = (id: string, name: string) => ({
  id,
  user_id: "workspace-user",
  name,
  cm_number: null,
  practice: null,
  memory_enabled: false,
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
});

const heading = () =>
  document.querySelector('[data-slot="sidebar-heading"]') as HTMLElement;

const openAccountMenu = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Account menu" }));

beforeEach(() => {
  vi.clearAllMocks();
  state.workspaceId = "personal";
  state.organizations = [];
  vi.mocked(listProjectSummaries).mockResolvedValue([]);
});

describe("AppSidebar workspace switcher", () => {
  it("offers nothing to switch between for somebody in no organization", async () => {
    const user = userEvent.setup();
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    expect(heading()).toHaveTextContent("Mike");
    await openAccountMenu(user);
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeVisible();
    expect(screen.queryByRole("menuitemradio")).not.toBeInTheDocument();
    expect(screen.queryByText("Workspace")).not.toBeInTheDocument();
  });

  it("heads the sidebar with the organization's name in its workspace", () => {
    state.organizations = [ACME, BETA];
    state.workspaceId = ACME.id;
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    expect(heading()).toHaveTextContent("Acme LLP");
    expect(heading()).not.toHaveTextContent("Mike");
    // Still the way home, whatever it is called.
    expect(screen.getByRole("link", { name: "Acme LLP" })).toHaveAttribute(
      "href",
      "/assistant",
    );
  });

  it("heads the sidebar with plain Mike for personal work, even with organizations to switch to", () => {
    state.organizations = [ACME, BETA];
    state.workspaceId = "personal";
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    expect(heading()).toHaveTextContent("Mike");
    expect(screen.queryByText("Personal")).not.toBeInTheDocument();
  });

  it("shows a placeholder, not Mike, while a remembered organization's name loads", () => {
    // "Mike" means personal work. Saying it for the moment before the
    // organization's name arrives would name the wrong workspace.
    state.organizations = null;
    state.workspaceId = ACME.id;
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    expect(
      screen.getByRole("status", { name: "Loading workspace" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Mike")).not.toBeInTheDocument();
  });

  it("sets an organization's name at the size Mike is, in the same fixed header row", () => {
    state.organizations = [ACME];
    state.workspaceId = ACME.id;
    const { unmount } = render(<AppSidebar isOpen onToggle={vi.fn()} />);
    const organizationClasses = heading().className;
    expect(heading()).toHaveClass("text-xl");
    expect(
      screen.getByRole("button", { name: "Close sidebar" }).parentElement,
    ).toHaveClass("h-11");
    unmount();

    // Switching workspace must not change how the header looks.
    state.workspaceId = "personal";
    render(<AppSidebar isOpen onToggle={vi.fn()} />);
    expect(heading().className).toBe(organizationClasses);
  });

  it("names nothing beside the account button", () => {
    state.organizations = [ACME];
    state.workspaceId = ACME.id;
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    expect(screen.queryByText(/Workspace:/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Account menu" }),
    ).not.toHaveTextContent("Acme LLP");
  });

  it("lists the workspaces in the account menu and marks the active one", async () => {
    state.organizations = [ACME, BETA];
    state.workspaceId = ACME.id;
    const user = userEvent.setup();
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    await openAccountMenu(user);
    const options = screen.getAllByRole("menuitemradio");
    expect(options.map((option) => option.textContent)).toEqual([
      "Personal",
      "Acme LLP",
      "Beta Chambers",
    ]);
    // The active one is marked by state, not by colour alone.
    expect(
      screen.getByRole("menuitemradio", { name: "Acme LLP" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("menuitemradio", { name: "Personal" }),
    ).toHaveAttribute("aria-checked", "false");
    // The rest of the account menu is still there.
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
  });

  it("switches workspace when another one is chosen", async () => {
    state.organizations = [ACME, BETA];
    const user = userEvent.setup();
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    await openAccountMenu(user);
    await user.click(
      screen.getByRole("menuitemradio", { name: "Beta Chambers" }),
    );
    expect(state.setWorkspace).toHaveBeenCalledWith(BETA.id);
  });

  it("keeps the switcher reachable from the collapsed sidebar", async () => {
    state.organizations = [ACME];
    const user = userEvent.setup();
    render(<AppSidebar isOpen={false} onToggle={vi.fn()} />);

    // The collapsed sidebar has no heading to name the workspace in.
    expect(document.querySelector('[data-slot="sidebar-heading"]')).toBeNull();
    await openAccountMenu(user);
    expect(
      screen.getByRole("menuitemradio", { name: "Acme LLP" }),
    ).toBeVisible();
  });

  it("loads the active workspace's recent projects, and reloads them on a switch", async () => {
    state.organizations = [ACME];
    vi.mocked(listProjectSummaries).mockImplementation(async (options) =>
      options?.workspace === ACME.id
        ? [project("p-org", "Firm matter")]
        : [project("p-mine", "My own matter")],
    );
    const { rerender } = render(<AppSidebar isOpen onToggle={vi.fn()} />);

    expect(await screen.findByText("My own matter")).toBeInTheDocument();
    expect(listProjectSummaries).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspace: "personal" }),
    );

    state.workspaceId = ACME.id;
    rerender(<AppSidebar isOpen onToggle={vi.fn()} />);

    expect(await screen.findByText("Firm matter")).toBeInTheDocument();
    expect(screen.queryByText("My own matter")).not.toBeInTheDocument();
    expect(listProjectSummaries).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspace: ACME.id }),
    );

    // Back again: Personal is painted from its own remembered list, never
    // from the organization's.
    state.workspaceId = "personal";
    rerender(<AppSidebar isOpen onToggle={vi.fn()} />);
    await waitFor(() =>
      expect(screen.queryByText("Firm matter")).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("My own matter")).toBeInTheDocument();
  });

  it("does not narrow the recent projects outside a workspace provider", async () => {
    state.workspaceId = null;
    state.organizations = null;
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    await waitFor(() => expect(listProjectSummaries).toHaveBeenCalled());
    expect(
      vi.mocked(listProjectSummaries).mock.calls[0][0]?.workspace,
    ).toBeUndefined();
    expect(heading()).toHaveTextContent("Mike");
  });
});
