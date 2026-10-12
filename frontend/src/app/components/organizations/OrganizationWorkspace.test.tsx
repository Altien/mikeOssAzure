import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MikeApiError } from "@/app/lib/mikeApi";
import { OrganizationWorkspace } from "./OrganizationWorkspace";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  role: "owner" as "owner" | "admin" | "member",
  getOrg: vi.fn(),
  listOrgMembers: vi.fn(),
  listOrgResources: vi.fn(),
  listOrgInvitations: vi.fn(),
  updateOrgMember: vi.fn(),
  removeOrgMember: vi.fn(),
  updateOrg: vi.fn(),
  deleteOrg: vi.fn(),
  createOrgInvitation: vi.fn(),
  cancelOrgInvitation: vi.fn(),
  resendOrgInvitation: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "me", email: "me@firm.example" } }),
}));
// The Model Providers tab has its own tests; here it only has to be reached.
vi.mock("./OrganizationProviderKeys", () => ({
  OrganizationProviderKeys: ({
    orgId,
    orgName,
  }: {
    orgId: string;
    orgName: string;
  }) => (
    <div data-testid="provider-keys">
      {orgId}|{orgName}
    </div>
  ),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getOrg: mocks.getOrg,
  listOrgMembers: mocks.listOrgMembers,
  listOrgResources: mocks.listOrgResources,
  listOrgInvitations: mocks.listOrgInvitations,
  updateOrgMember: mocks.updateOrgMember,
  removeOrgMember: mocks.removeOrgMember,
  updateOrg: mocks.updateOrg,
  deleteOrg: mocks.deleteOrg,
  createOrgInvitation: mocks.createOrgInvitation,
  cancelOrgInvitation: mocks.cancelOrgInvitation,
  resendOrgInvitation: mocks.resendOrgInvitation,
}));

beforeEach(() => {
  vi.clearAllMocks();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  mocks.role = "owner";
  mocks.getOrg.mockImplementation(async () => ({
    id: "org-1",
    name: "Elite Law LLP",
    created_by: "me",
    role: mocks.role,
  }));
  mocks.listOrgMembers.mockResolvedValue([
    {
      id: "m1",
      user_id: "me",
      display_name: "William Chen",
      email: "me@firm.example",
      role: "owner",
      created_at: "2026-08-30T00:00:00Z",
    },
    {
      id: "m2",
      user_id: "u2",
      display_name: "Jane Lee",
      email: "jane@firm.example",
      role: "member",
      created_at: "2026-09-01T00:00:00Z",
    },
  ]);
  mocks.listOrgResources.mockResolvedValue({
    projects: [
      {
        id: "project-1",
        user_id: "me",
        org_id: "org-1",
        name: "Apollo",
        practice: "Corporate",
        created_at: "2026-09-01T00:00:00Z",
      },
    ],
    workflows: [
      {
        id: "workflow-1",
        user_id: "u2",
        org_id: "org-1",
        title: "Disclosure workflow",
        type: "tabular",
        practice: "Corporate",
        created_at: "2026-09-01T00:00:00Z",
      },
    ],
  });
  mocks.listOrgInvitations.mockResolvedValue([]);
});

describe("OrganizationWorkspace", () => {
  it("shows the breadcrumb, member identity columns, and every resource tab", async () => {
    const user = userEvent.setup();
    render(<OrganizationWorkspace orgId="org-1" />);

    expect(await screen.findByText("William Chen")).toBeInTheDocument();
    expect(screen.getByText("me@firm.example")).toBeInTheDocument();
    expect(screen.getAllByText("Elite Law LLP")).not.toHaveLength(0);
    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Select all people" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Filter by role" }),
    ).toBeInTheDocument();
    const peopleRow = screen
      .getByRole("checkbox", { name: "Select Jane Lee" })
      .closest(".group");
    expect(peopleRow).toHaveClass("liquid-glass-hover");
    expect(peopleRow).not.toHaveClass("cursor-pointer");

    await user.click(screen.getByRole("button", { name: "Projects" }));
    expect(screen.getByRole("link", { name: "Open Apollo" })).toHaveClass(
      "liquid-glass-hover",
    );
    await user.click(screen.getByRole("button", { name: "Workflows" }));
    expect(
      screen.getByRole("link", { name: "Open Disclosure workflow" }),
    ).toHaveClass("liquid-glass-hover");
    expect(screen.queryByRole("button", { name: "Chats" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reviews" })).not.toBeInTheDocument();
  });

  it("opens the organization's model providers from their own tab", async () => {
    const user = userEvent.setup();
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("Jane Lee");

    await user.click(screen.getByRole("button", { name: "Model Providers" }));

    expect(screen.getByTestId("provider-keys")).toHaveTextContent(
      "org-1|Elite Law LLP",
    );
    expect(screen.queryByText("Jane Lee")).not.toBeInTheDocument();
  });

  it("lets owners change a member's role from the colored role tab", async () => {
    const user = userEvent.setup();
    mocks.updateOrgMember.mockResolvedValue({});
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("Jane Lee");

    const roleTab = screen.getByRole("button", {
      name: "Change role for Jane Lee",
    });
    expect(roleTab).toHaveClass("bg-violet-100", "text-violet-700");
    await user.click(roleTab);
    await user.click(screen.getByRole("menuitem", { name: "Admin" }));

    await waitFor(() =>
      expect(mocks.updateOrgMember).toHaveBeenCalledWith(
        "org-1",
        "u2",
        "admin",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Change role for Jane Lee" }),
    ).toHaveClass("bg-blue-100", "text-blue-700");
  });

  it("shows last-owner failures with the warning primitive", async () => {
    const user = userEvent.setup();
    mocks.updateOrgMember.mockRejectedValue(
      new MikeApiError({
        status: 409,
        message: "An organization must keep at least one owner.",
      }),
    );
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(
      screen.getByRole("button", { name: "Change role for William Chen" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Member" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByText("An organization must keep at least one owner."),
    ).toBeInTheDocument();
    expect(screen.getByText("Organization action failed")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Dismiss warning" }),
    ).toBeInTheDocument();
  });

  it.each([["Jane Lee"], ["William Chen"], ["Jane Lee", "William Chen"]])("matches the toolbar and right-click people menu for %j", async (...names) => {
    const user = userEvent.setup();
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("Jane Lee");
    for (const name of names) await user.click(screen.getByRole("checkbox", { name: `Select ${name}` }));
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(items).toEqual([names.length > 1 ? "Remove all selected" : names[0] === "William Chen" ? "Leave organization" : "Remove member"]);
    await user.keyboard("{Escape}");
    fireEvent.contextMenu(screen.getByText(names[0]), { clientX: 40, clientY: 40 });
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(items);
  });

  it("reveals a toolbar action and removes selected people", async () => {
    const user = userEvent.setup();
    mocks.removeOrgMember.mockResolvedValue(undefined);
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("Jane Lee");

    expect(
      screen.queryByRole("button", { name: "Actions" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Select Jane Lee" }));
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const removeAction = screen.getByRole("menuitem", {
      name: "Remove member",
    });
    expect(removeAction).toHaveClass("text-red-600");
    await user.click(removeAction);

    expect(screen.getByText("Remove member?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(mocks.removeOrgMember).toHaveBeenCalledWith("org-1", "u2"),
    );
    expect(screen.queryByText("Jane Lee")).not.toBeInTheDocument();
  });

  it("warns an owner who includes themselves in bulk removal", async () => {
    const user = userEvent.setup();
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(
      screen.getByRole("checkbox", { name: "Select William Chen" }),
    );
    await user.click(screen.getByRole("checkbox", { name: "Select Jane Lee" }));
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Remove all selected" }),
    );

    // The refusal is about the route, not about owner arithmetic: leaving is
    // a different action, and saying "must keep at least one owner" was wrong
    // however many owners the organization had.
    expect(
      await screen.findByText("Use Leave organization to remove yourself."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("An organization must keep at least one owner."),
    ).not.toBeInTheDocument();
    expect(mocks.removeOrgMember).not.toHaveBeenCalled();
  });

  it("offers add-member and settings actions only to admins", async () => {
    const user = userEvent.setup();
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(screen.getByRole("button", { name: "Add member" }));
    expect(screen.getByText("Email address")).toBeInTheDocument();
    expect(mocks.listOrgInvitations).toHaveBeenCalledWith("org-1");

    await user.keyboard("{Escape}");
    await user.click(
      screen.getByRole("button", { name: "Organization settings" }),
    );
    await user.click(screen.getByText("Organization settings"));
    expect(screen.getByLabelText("Organization name")).toHaveValue(
      "Elite Law LLP",
    );
  });

  it("drops owner and admin controls as soon as an owner demotes themselves", async () => {
    const user = userEvent.setup();
    mocks.updateOrgMember.mockResolvedValue({});
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(
      screen.getByRole("button", { name: "Change role for William Chen" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Member" }));

    // Losing your own owner rights is confirmed before it happens.
    expect(screen.getByText("Give up owner access?")).toBeInTheDocument();
    expect(mocks.updateOrgMember).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(mocks.updateOrgMember).toHaveBeenCalledWith(
        "org-1",
        "me",
        "member",
      ),
    );
    // org.role has to follow the membership row, or the page keeps offering
    // admin actions that now 403 until a reload.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Organization settings" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "Change role for Jane Lee" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Only organization admins can add members",
      }),
    ).toBeDisabled();
    expect(mocks.getOrg).toHaveBeenCalledTimes(1);
  });

  it("keeps the self-demotion confirmation up while the change is in flight", async () => {
    // The popup was closed before the request was sent, so the busy state it
    // is handed could never render and the click read as a no-op.
    const user = userEvent.setup();
    let settle: (() => void) | undefined;
    mocks.updateOrgMember.mockImplementation(
      () =>
        new Promise<Record<string, never>>((resolve) => {
          settle = () => resolve({});
        }),
    );
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(
      screen.getByRole("button", { name: "Change role for William Chen" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Member" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(mocks.updateOrgMember).toHaveBeenCalledTimes(1),
    );
    expect(screen.getByText("Give up owner access?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continuing..." })).toBeDisabled();

    settle?.();

    await waitFor(() =>
      expect(screen.queryByText("Give up owner access?")).not.toBeInTheDocument(),
    );
  });

  it("spends Escape on the delete confirmation before the settings modal", async () => {
    const user = userEvent.setup();
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(
      screen.getByRole("button", { name: "Organization settings" }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Organization settings" }),
    );
    const nameInput = screen.getByLabelText("Organization name");
    await user.clear(nameInput);
    await user.type(nameInput, "Elite Law Group");
    await user.click(
      screen.getByRole("button", { name: "Delete organization" }),
    );
    expect(screen.getByText("Delete Elite Law LLP?")).toBeInTheDocument();

    // Both layers answered Escape, so declining the delete also closed the
    // settings modal and threw away the rename typed above it. The
    // confirmation is on top, so it alone takes the first press.
    await user.keyboard("{Escape}");

    expect(screen.queryByText("Delete Elite Law LLP?")).not.toBeInTheDocument();
    expect(mocks.deleteOrg).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Organization name")).toHaveValue(
      "Elite Law Group",
    );

    // With the confirmation gone the next press belongs to the modal.
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByLabelText("Organization name")).not.toBeInTheDocument(),
    );
  });

  it("retires the delete confirmation when its settings modal closes", async () => {
    // The confirmation renders in its own portal, so closing the modal by
    // other means must take it down too: otherwise it keeps floating over
    // the page with a live Delete button still wired to this org.
    const user = userEvent.setup();
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(
      screen.getByRole("button", { name: "Organization settings" }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Organization settings" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Delete organization" }),
    );
    expect(screen.getByText("Delete Elite Law LLP?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() =>
      expect(
        screen.queryByText("Delete Elite Law LLP?"),
      ).not.toBeInTheDocument(),
    );
    expect(mocks.deleteOrg).not.toHaveBeenCalled();
  });

  it("does not report a sent invitation as failed when the refresh rejects", async () => {
    const user = userEvent.setup();
    mocks.createOrgInvitation.mockResolvedValue({});
    mocks.listOrgInvitations
      .mockResolvedValueOnce([])
      .mockRejectedValue(new Error("refresh failed"));
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(screen.getByRole("button", { name: "Add member" }));
    // ModalUI settles focus a frame after the dialog opens (the auto-focused
    // field keeps it, else the first control); typing across that handoff
    // loses the tail of the address, so wait for focus to land in the dialog.
    await waitFor(() => {
      const dialog = screen.getByRole("dialog");
      expect(document.activeElement).not.toBe(document.body);
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
    await user.type(
      screen.getByPlaceholderText("Invite by email…"),
      "new@firm.example",
    );
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(mocks.createOrgInvitation).toHaveBeenCalledWith(
        "org-1",
        "new@firm.example",
        "member",
      ),
    );
    expect(
      await screen.findByText("Invitation sent to new@firm.example."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Could not send the invitation."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Invitation action failed"),
    ).not.toBeInTheDocument();
  });

  it("re-reads invitations and the roster when the Add member modal opens", async () => {
    // An invitation is accepted in the recipient's browser, so this page never
    // hears about it. Opening Add member used to redisplay the list loaded at
    // page load, which still called the new colleague "Pending" — and the
    // People table behind it still did not have them at all.
    const user = userEvent.setup();
    const invitation = {
      id: "i1",
      org_id: "org-1",
      email: "newjoiner@firm.example",
      role: "member" as const,
      invited_by: "me",
      expires_at: "2026-09-30T00:00:00Z",
      created_at: "2026-09-01T00:00:00Z",
      accepted_at: null,
      declined_at: null,
      cancelled_at: null,
    };
    const joiner = {
      id: "m3",
      user_id: "u3",
      display_name: "New Joiner",
      email: "newjoiner@firm.example",
      role: "member",
      created_at: "2026-09-02T00:00:00Z",
    };
    mocks.listOrgInvitations
      .mockResolvedValueOnce([{ ...invitation, status: "pending" }])
      .mockResolvedValue([
        {
          ...invitation,
          status: "accepted",
          accepted_at: "2026-09-02T00:00:00Z",
        },
      ]);
    const initialMembers = [
      {
        id: "m1",
        user_id: "me",
        display_name: "William Chen",
        email: "me@firm.example",
        role: "owner",
        created_at: "2026-08-30T00:00:00Z",
      },
    ];
    mocks.listOrgMembers
      .mockResolvedValueOnce(initialMembers)
      .mockResolvedValue([...initialMembers, joiner]);

    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("William Chen");
    expect(screen.queryByText("New Joiner")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add member" }));

    await waitFor(() =>
      expect(mocks.listOrgInvitations).toHaveBeenCalledTimes(2),
    );
    // The accepted invitation is no longer pending, so its row is gone...
    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: "Cancel invitation to newjoiner@firm.example",
        }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("Pending invitations")).not.toBeInTheDocument();
    // ...and the same person is now on the roster without a reload.
    expect(screen.getByText("New Joiner")).toBeInTheDocument();
  });

  it("ignores a stale roster response that answers after a newer one", async () => {
    // Two readers write this roster — the page load and the refresh that runs
    // whenever the Add member modal opens or closes — and nothing ordered
    // them. Whichever response landed LAST won: a three-person roster was
    // seen collapsing to one when the older answer came back second.
    const user = userEvent.setup();
    const chen = {
      id: "m1",
      user_id: "me",
      display_name: "William Chen",
      email: "me@firm.example",
      role: "owner",
      created_at: "2026-08-30T00:00:00Z",
    };
    const lee = {
      id: "m2",
      user_id: "u2",
      display_name: "Jane Lee",
      email: "jane@firm.example",
      role: "member",
      created_at: "2026-09-01T00:00:00Z",
    };
    const joiner = {
      id: "m3",
      user_id: "u3",
      display_name: "New Joiner",
      email: "newjoiner@firm.example",
      role: "member",
      created_at: "2026-09-02T00:00:00Z",
    };
    const stale: { release: (members: unknown[]) => void } = {
      release: () => {},
    };
    mocks.listOrgMembers
      // The page load.
      .mockResolvedValueOnce([chen, lee])
      // Opening the modal: this read is overtaken and must not be applied.
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            stale.release = resolve;
          }),
      )
      // Closing it: the newest answer, and the one the table must keep.
      .mockResolvedValue([chen, lee, joiner]);

    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(screen.getByRole("button", { name: "Add member" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");

    // The close path re-reads BOTH lists, not the roster alone.
    await waitFor(() => expect(screen.getByText("New Joiner")).toBeInTheDocument());
    expect(mocks.listOrgInvitations.mock.calls.length).toBeGreaterThan(2);

    // Now the overtaken read finally answers, with the roster as it was.
    stale.release([chen]);
    await waitFor(() =>
      expect(mocks.listOrgMembers).toHaveBeenCalledTimes(3),
    );
    expect(screen.getByText("New Joiner")).toBeInTheDocument();
    expect(screen.getByText("Jane Lee")).toBeInTheDocument();
  });

  it("says so when refreshing the people lists fails", async () => {
    // A console line is not a user interface. The admin was left reading a
    // roster that had quietly stopped tracking the server.
    const user = userEvent.setup();
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("William Chen");
    // The page loaded; it is the refresh behind the modal that fails.
    mocks.listOrgMembers.mockRejectedValue(new Error("network"));

    await user.click(screen.getByRole("button", { name: "Add member" }));

    expect(
      await screen.findByText("Organization action failed"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This organization's people could not be refreshed. Reload to see the current list.",
      ),
    ).toBeInTheDocument();
  });

  it("lets members browse resources but does not load administrative invitations", async () => {
    mocks.role = "member";
    const user = userEvent.setup();
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("William Chen");

    expect(mocks.listOrgInvitations).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", {
        name: "Only organization admins can add members",
      }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Organization settings" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Workflows" }));
    expect(screen.getByText("Disclosure workflow")).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // An admin runs the organization day to day; an owner decides who does.
  // The server refuses each of these, so offering them only produced a 403.
  // -------------------------------------------------------------------------
  describe("as an admin who is not an owner", () => {
    beforeEach(() => {
      mocks.role = "admin";
      mocks.listOrgMembers.mockResolvedValue([
        {
          id: "m1",
          user_id: "me",
          display_name: "William Chen",
          email: "me@firm.example",
          role: "admin",
          created_at: "2026-08-30T00:00:00Z",
        },
        {
          id: "m2",
          user_id: "u2",
          display_name: "Jane Lee",
          email: "jane@firm.example",
          role: "member",
          created_at: "2026-09-01T00:00:00Z",
        },
        {
          id: "m3",
          user_id: "u3",
          display_name: "Olive Owner",
          email: "olive@firm.example",
          role: "owner",
          created_at: "2026-08-01T00:00:00Z",
        },
        {
          id: "m4",
          user_id: "u4",
          display_name: "Adam Admin",
          email: "adam@firm.example",
          role: "admin",
          created_at: "2026-08-02T00:00:00Z",
        },
      ]);
    });

    it("shows every role as plain text, because none of them is theirs to change", async () => {
      render(<OrganizationWorkspace orgId="org-1" />);
      await screen.findByText("Olive Owner");

      for (const name of [
        "William Chen",
        "Jane Lee",
        "Olive Owner",
        "Adam Admin",
      ]) {
        expect(
          screen.queryByRole("button", { name: `Change role for ${name}` }),
        ).not.toBeInTheDocument();
      }
      expect(screen.getByText("Owner")).toHaveClass(
        "bg-amber-100",
        "text-amber-700",
      );
    });

    it("offers removal for members and for themselves only", async () => {
      render(<OrganizationWorkspace orgId="org-1" />);
      await screen.findByText("Olive Owner");

      expect(
        screen.getByRole("button", { name: "Actions for Jane Lee" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Actions for William Chen" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Actions for Olive Owner" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Actions for Adam Admin" }),
      ).not.toBeInTheDocument();

      // The right-click menu is the same decision reached another way.
      fireEvent.contextMenu(screen.getByText("Olive Owner"), {
        clientX: 40,
        clientY: 40,
      });
      expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
    });

    it("refuses a bulk removal that includes an owner or another admin", async () => {
      const user = userEvent.setup();
      render(<OrganizationWorkspace orgId="org-1" />);
      await screen.findByText("Olive Owner");

      await user.click(
        screen.getByRole("checkbox", { name: "Select Jane Lee" }),
      );
      await user.click(
        screen.getByRole("checkbox", { name: "Select Olive Owner" }),
      );
      await user.click(screen.getByRole("button", { name: "Actions" }));
      await user.click(
        screen.getByRole("menuitem", { name: "Remove all selected" }),
      );

      expect(
        await screen.findByText(
          "Only an organization owner can remove admins and other owners.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Remove selected people?"),
      ).not.toBeInTheDocument();
      expect(mocks.removeOrgMember).not.toHaveBeenCalled();
    });

    it("lets them rename the organization but not delete it", async () => {
      const user = userEvent.setup();
      render(<OrganizationWorkspace orgId="org-1" />);
      await screen.findByText("Olive Owner");

      await user.click(
        screen.getByRole("button", { name: "Organization settings" }),
      );
      await user.click(screen.getByText("Organization settings"));
      expect(screen.getByLabelText("Organization name")).toHaveValue(
        "Elite Law LLP",
      );
      expect(
        screen.queryByRole("button", { name: "Delete organization" }),
      ).not.toBeInTheDocument();
    });

    it("invites members only, and leaves an owner's admin invitation alone", async () => {
      const user = userEvent.setup();
      mocks.listOrgInvitations.mockResolvedValue([
        {
          id: "i1",
          org_id: "org-1",
          email: "partner@firm.example",
          role: "admin",
          invited_by: "u3",
          status: "pending",
          expires_at: "2026-12-01T00:00:00Z",
          created_at: "2026-10-01T00:00:00Z",
          accepted_at: null,
        },
        {
          id: "i2",
          org_id: "org-1",
          email: "associate@firm.example",
          role: "member",
          invited_by: "me",
          status: "pending",
          expires_at: "2026-12-01T00:00:00Z",
          created_at: "2026-10-01T00:00:00Z",
          accepted_at: null,
        },
      ]);
      render(<OrganizationWorkspace orgId="org-1" />);
      await screen.findByText("Olive Owner");

      await user.click(screen.getByRole("button", { name: "Add member" }));
      // No picker: Member is the only role an admin may hand out.
      expect(screen.queryByLabelText("Role")).not.toBeInTheDocument();
      expect(
        screen.getByText(/Only an organization owner can invite admins\./),
      ).toBeInTheDocument();

      expect(
        screen.getByRole("button", {
          name: "Resend invitation to partner@firm.example",
        }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", {
          name: "Cancel invitation to partner@firm.example",
        }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", {
          name: "Cancel invitation to associate@firm.example",
        }),
      ).toBeEnabled();
    });
  });

  it("lets an owner hand out every role, ownership included", async () => {
    const user = userEvent.setup();
    mocks.updateOrgMember.mockResolvedValue({});
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("Jane Lee");

    await user.click(
      screen.getByRole("button", { name: "Change role for Jane Lee" }),
    );
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Owner", "Admin", "Member"]);
    await user.click(screen.getByRole("menuitem", { name: "Owner" }));

    await waitFor(() =>
      expect(mocks.updateOrgMember).toHaveBeenCalledWith(
        "org-1",
        "u2",
        "owner",
      ),
    );
  });

  it("words an owner stepping down to admin as losing ownership, not administration", async () => {
    const user = userEvent.setup();
    mocks.updateOrgMember.mockResolvedValue({});
    render(<OrganizationWorkspace orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(
      screen.getByRole("button", { name: "Change role for William Chen" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Admin" }));

    expect(screen.getByText("Step down to admin?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(mocks.updateOrgMember).toHaveBeenCalledWith(
        "org-1",
        "me",
        "admin",
      ),
    );
    // Still an admin: settings stay, deletion and role changes go.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Change role for Jane Lee" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Organization settings" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add member" })).toBeEnabled();
  });
});
