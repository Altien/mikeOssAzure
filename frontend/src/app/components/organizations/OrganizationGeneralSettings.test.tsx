import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MikeApiError, type Org } from "@/app/lib/mikeApi";
import { OrganizationGeneralSettings } from "./OrganizationGeneralSettings";

// The General section of an organization's settings. What this pins:
//
//   - who sees what: everyone the name, their role and the way out; owners
//     and admins the rename; owners alone the delete
//   - the name is an inline field, saved when it is left
//   - carried over from the dialog this replaced: a delete confirmation that
//     closes once the delete succeeds, and a refused delete that is named a
//     failed delete rather than unsaved settings

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  org: null as Org | null,
  setOrg: vi.fn(),
  refreshOrganizations: vi.fn(async () => {}),
  updateOrg: vi.fn(),
  deleteOrg: vi.fn(),
  removeOrgMember: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "me", email: "me@firm.example" } }),
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
  useWorkspace: () => ({ refreshOrganizations: mocks.refreshOrganizations }),
}));
vi.mock("./OrganizationSettingsShell", () => ({
  useOrganizationSettings: () => ({
    orgId: "org-1",
    org: mocks.org,
    setOrg: mocks.setOrg,
    reload: vi.fn(),
  }),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  updateOrg: mocks.updateOrg,
  deleteOrg: mocks.deleteOrg,
  removeOrgMember: mocks.removeOrgMember,
}));

const orgAs = (role: Org["role"]): Org =>
  ({
    id: "org-1",
    name: "Elite Law LLP",
    created_by: "someone",
    role,
    member_count: 4,
  }) as Org;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.org = orgAs("owner");
  // Renaming puts the new organization in place, as the settings area does.
  mocks.setOrg.mockImplementation((next: Org) => {
    mocks.org = next;
  });
});

const nameField = () => screen.getByLabelText("Organization name");

describe("who sees what", () => {
  it("shows an owner the name field, their role, the way out and the delete", () => {
    render(<OrganizationGeneralSettings />);

    expect(nameField()).toHaveValue("Elite Law LLP");
    expect(
      within(screen.getByRole("region", { name: "Your Membership" })).getByText(
        "Owner",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("lets an admin rename the organization but not delete it", () => {
    mocks.org = orgAs("admin");
    render(<OrganizationGeneralSettings />);

    expect(nameField()).toHaveValue("Elite Law LLP");
    expect(
      screen.queryByRole("button", { name: "Delete" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Delete Organization" }),
    ).not.toBeInTheDocument();
  });

  it("shows a member the name as text, with nothing to change but their own membership", () => {
    mocks.org = orgAs("member");
    render(<OrganizationGeneralSettings />);

    expect(screen.getByText("Elite Law LLP")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete" }),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Your Membership" })).getByText(
        "Member",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave" })).toBeEnabled();
  });

  it("offers nothing to press until the organization has loaded", () => {
    mocks.org = null;
    render(<OrganizationGeneralSettings />);

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Delete" }),
    ).not.toBeInTheDocument();
  });
});

describe("renaming", () => {
  it("saves the name when the field is left, and tells the sidebar", async () => {
    const user = userEvent.setup();
    mocks.updateOrg.mockResolvedValue({
      ...orgAs("owner"),
      name: "Elite Law Group",
    });
    render(<OrganizationGeneralSettings />);

    await user.clear(nameField());
    await user.type(nameField(), "  Elite Law Group ");
    await user.tab();

    await waitFor(() =>
      expect(mocks.updateOrg).toHaveBeenCalledExactlyOnceWith(
        "org-1",
        "Elite Law Group",
      ),
    );
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(mocks.setOrg).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Elite Law Group", member_count: 4 }),
    );
    expect(mocks.refreshOrganizations).toHaveBeenCalledTimes(1);
  });

  it("saves on Enter too", async () => {
    const user = userEvent.setup();
    mocks.updateOrg.mockResolvedValue({ ...orgAs("owner"), name: "Renamed" });
    render(<OrganizationGeneralSettings />);

    await user.clear(nameField());
    await user.type(nameField(), "Renamed{Enter}");

    await waitFor(() =>
      expect(mocks.updateOrg).toHaveBeenCalledWith("org-1", "Renamed"),
    );
  });

  it("does not save a name that has not changed, or an empty one", async () => {
    const user = userEvent.setup();
    render(<OrganizationGeneralSettings />);

    await user.click(nameField());
    await user.tab();
    await user.clear(nameField());
    await user.tab();

    expect(mocks.updateOrg).not.toHaveBeenCalled();
    // The empty box goes back to the name the organization still has.
    expect(nameField()).toHaveValue("Elite Law LLP");
  });

  it("shows why a rename was refused, beside the field", async () => {
    const user = userEvent.setup();
    mocks.updateOrg.mockRejectedValue(
      new MikeApiError({
        message: "An organization with that name already exists.",
        status: 409,
      }),
    );
    render(<OrganizationGeneralSettings />);

    await user.clear(nameField());
    await user.type(nameField(), "Taken");
    await user.tab();

    expect(
      await screen.findByText("An organization with that name already exists."),
    ).toBeInTheDocument();
    expect(mocks.setOrg).not.toHaveBeenCalled();
    expect(mocks.refreshOrganizations).not.toHaveBeenCalled();
  });
});

describe("leaving", () => {
  it("is a black button, the one action the section offers everyone", () => {
    mocks.org = orgAs("member");
    render(<OrganizationGeneralSettings />);
    const leave = screen.getByRole("button", { name: "Leave" });
    // Same pill as Delete beside it for an owner, set apart by tone.
    expect(leave.className).toMatch(/bg-(black|gray-9\d\d)/);
  });

  it("asks first, then removes the caller and takes them to their organizations", async () => {
    const user = userEvent.setup();
    mocks.org = orgAs("member");
    mocks.removeOrgMember.mockResolvedValue(undefined);
    render(<OrganizationGeneralSettings />);

    await user.click(screen.getByRole("button", { name: "Leave" }));
    expect(screen.getByText("Leave organization?")).toBeInTheDocument();
    expect(mocks.removeOrgMember).not.toHaveBeenCalled();

    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Leave",
      }),
    );

    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith("/settings/organizations"),
    );
    expect(mocks.removeOrgMember).toHaveBeenCalledExactlyOnceWith(
      "org-1",
      "me",
    );
    expect(mocks.refreshOrganizations).toHaveBeenCalledTimes(1);
  });

  it("says why the last owner cannot leave, and stays put", async () => {
    const user = userEvent.setup();
    mocks.removeOrgMember.mockRejectedValue(
      new MikeApiError({
        message: "An organization must keep at least one owner.",
        status: 409,
      }),
    );
    render(<OrganizationGeneralSettings />);

    await user.click(screen.getByRole("button", { name: "Leave" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Leave",
      }),
    );

    expect(
      await screen.findByText("Could not leave the organization"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("An organization must keep at least one owner."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Leave organization?")).not.toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

describe("deleting", () => {
  const confirmDelete = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Delete Elite Law LLP?")).toBeInTheDocument();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete",
      }),
    );
  };

  it("closes the confirmation once the delete succeeds, and leaves", async () => {
    // It was reset on failure and not on success, so after a delete that
    // worked it stayed open over a page navigating away, with a live Delete
    // button aimed at an organization that was gone.
    const user = userEvent.setup();
    mocks.deleteOrg.mockResolvedValue(undefined);
    render(<OrganizationGeneralSettings />);

    await confirmDelete(user);

    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith("/settings/organizations"),
    );
    expect(mocks.deleteOrg).toHaveBeenCalledExactlyOnceWith("org-1");
    expect(screen.queryByText("Delete Elite Law LLP?")).not.toBeInTheDocument();
    expect(mocks.refreshOrganizations).toHaveBeenCalledTimes(1);
    // It cannot be fired a second time during the navigation.
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });

  it("names the failure a failed delete, with the server's reason", async () => {
    const user = userEvent.setup();
    mocks.deleteOrg.mockRejectedValue(
      new MikeApiError({
        message: "Move or delete this organization's projects first.",
        status: 409,
      }),
    );
    render(<OrganizationGeneralSettings />);

    await confirmDelete(user);

    expect(
      await screen.findByText("Organization not deleted"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Move or delete this organization's projects first."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Delete Elite Law LLP?")).not.toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
    // Still theirs to try again once it is empty.
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("does nothing until the confirmation is answered", async () => {
    const user = userEvent.setup();
    render(<OrganizationGeneralSettings />);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );

    expect(mocks.deleteOrg).not.toHaveBeenCalled();
    expect(screen.queryByText("Delete Elite Law LLP?")).not.toBeInTheDocument();
  });
});
