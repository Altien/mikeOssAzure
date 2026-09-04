import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OrganizationsOverview } from "./OrganizationsOverview";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  listOrgs: vi.fn(),
  listMyOrgInvitations: vi.fn(),
  createOrg: vi.fn(),
  createOrgInvitation: vi.fn(),
  acceptOrgInvitation: vi.fn(),
  declineOrgInvitation: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/app/lib/mikeApi", () => ({
  listOrgs: mocks.listOrgs,
  listMyOrgInvitations: mocks.listMyOrgInvitations,
  createOrg: mocks.createOrg,
  createOrgInvitation: mocks.createOrgInvitation,
  acceptOrgInvitation: mocks.acceptOrgInvitation,
  declineOrgInvitation: mocks.declineOrgInvitation,
}));

const ORG = {
  id: "org-1",
  name: "Elite Law LLP",
  created_by: "me",
  created_at: "2026-09-01T00:00:00.000Z",
  role: "admin" as const,
  member_count: 3,
};

const JOINED_ORG = {
  ...ORG,
  id: "org-joined",
  name: "Community Legal",
  role: "member" as const,
  member_count: 8,
};

const INVITATION = {
  id: "invite-1",
  org_id: "org-invited",
  org_name: "Inviting Chambers",
  email: "me@example.com",
  role: "member" as const,
  invited_by: "inviter-1",
  status: "pending" as const,
  expires_at: "2026-09-10T00:00:00.000Z",
  created_at: "2026-09-01T00:00:00.000Z",
  accepted_at: null,
  declined_at: null,
  cancelled_at: null,
};

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
  mocks.listOrgs.mockResolvedValue([ORG]);
  mocks.listMyOrgInvitations.mockResolvedValue([]);
});

describe("OrganizationsOverview", () => {
  it("renders organizations through the shared table columns and opens a row", async () => {
    const user = userEvent.setup();
    render(<OrganizationsOverview />);

    expect(await screen.findByText("Elite Law LLP")).toBeInTheDocument();
    expect(screen.getByText("3 members")).toBeInTheDocument();
    expect(screen.getByText("Created")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sort by organization name" }),
    ).toBeInTheDocument();

    const organizationRow = screen.getByRole("link", {
      name: "Open Elite Law LLP",
    });

    await user.click(organizationRow);
    expect(mocks.push).toHaveBeenCalledWith("/organizations/org-1");
  });

  it("creates an organization from the page-header plus action", async () => {
    const user = userEvent.setup();
    mocks.createOrg.mockResolvedValue({
      ...ORG,
      id: "org-2",
      name: "New Chambers",
    });
    render(<OrganizationsOverview />);
    await screen.findByText("Elite Law LLP");

    await user.click(screen.getByRole("button", { name: "New organization" }));
    expect(
      await screen.findByText(/You can also add people later/),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("Organization name"), "New Chambers");
    await user.type(
      screen.getByPlaceholderText("Add member by email…"),
      "jane@firm.example",
    );
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(mocks.createOrg).toHaveBeenCalledWith("New Chambers"),
    );
    expect(mocks.createOrgInvitation).toHaveBeenCalledWith(
      "org-2",
      "jane@firm.example",
      "member",
    );
    expect(mocks.push).toHaveBeenCalledWith("/organizations/org-2");
  });

  it("separates organizations into Managing and Joined tabs", async () => {
    const user = userEvent.setup();
    mocks.listOrgs.mockResolvedValue([ORG, JOINED_ORG]);
    render(<OrganizationsOverview />);

    expect(await screen.findByText("Elite Law LLP")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Managing" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invites" })).toBeInTheDocument();
    expect(screen.queryByText("Community Legal")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Joined" }));
    expect(screen.getByText("Community Legal")).toBeInTheDocument();
    expect(screen.queryByText("Elite Law LLP")).not.toBeInTheDocument();
  });

  it("shows active invitations and their count under the Invites pill", async () => {
    const user = userEvent.setup();
    mocks.listMyOrgInvitations.mockResolvedValueOnce([INVITATION]);
    render(<OrganizationsOverview />);

    const invites = await screen.findByRole("button", {
      name: "Invites (1)",
    });
    expect(screen.queryByText("Inviting Chambers")).not.toBeInTheDocument();

    await user.click(invites);
    expect(screen.getByText("Inviting Chambers")).toBeInTheDocument();
    expect(screen.getByText(/invited you as Member/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(mocks.acceptOrgInvitation).toHaveBeenCalledWith("invite-1"),
    );
    expect(
      await screen.findByRole("button", { name: "Invites" }),
    ).toBeInTheDocument();
  });
});
