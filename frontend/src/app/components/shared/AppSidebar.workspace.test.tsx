import { render, screen, waitFor, within } from "@testing-library/react";
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

    expect(screen.queryByText(/Workspace:/)).not.toBeInTheDocument();
    await openAccountMenu(user);
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeVisible();
    expect(screen.queryByRole("menuitemradio")).not.toBeInTheDocument();
    expect(screen.queryByText("Workspace")).not.toBeInTheDocument();
  });

  it("names the active workspace beside the account and lists the others", async () => {
    state.organizations = [ACME, BETA];
    state.workspaceId = ACME.id;
    const user = userEvent.setup();
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    expect(screen.getByText("Acme LLP").closest("p")).toHaveTextContent(
      "Workspace: Acme LLP",
    );

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

    // No room for the name beside a collapsed account button.
    expect(screen.queryByText(/Workspace:/)).not.toBeInTheDocument();
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
    expect(within(document.body).queryByText(/Workspace:/)).toBeNull();
  });
});
