import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OrganizationSettings } from "./OrganizationSettings";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  role: "owner" as "owner" | "admin" | "member",
  getOrg: vi.fn(),
  updateOrg: vi.fn(),
  deleteOrg: vi.fn(),
  refreshOrganizations: vi.fn(async () => {}),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
  useWorkspace: () => ({ refreshOrganizations: mocks.refreshOrganizations }),
}));
// The provider sections have their own tests; here they only have to be on
// the page for the people allowed to see it.
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
  updateOrg: mocks.updateOrg,
  deleteOrg: mocks.deleteOrg,
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
});

const renderPage = () => render(<OrganizationSettings orgId="org-1" />);
const general = () => screen.getByRole("region", { name: "General" });
const openDetails = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(
    await within(general()).findByRole("button", { name: /^Rename/ }),
  );

describe("who may open organization settings", () => {
  it("shows an owner the name, the model providers and a way to delete", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(
      await within(general()).findByText("Elite Law LLP"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Rename the organization, or delete it."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("provider-keys")).toHaveTextContent(
      "org-1|Elite Law LLP",
    );

    await openDetails(user);
    expect(screen.getByLabelText("Organization name")).toHaveValue(
      "Elite Law LLP",
    );
    expect(
      screen.getByRole("button", { name: "Delete organization" }),
    ).toBeInTheDocument();
  });

  it("lets an admin in, to rename the organization but not delete it", async () => {
    mocks.role = "admin";
    const user = userEvent.setup();
    renderPage();

    expect(
      await screen.findByText("Rename the organization."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("provider-keys")).toBeInTheDocument();

    await openDetails(user);
    expect(screen.getByLabelText("Organization name")).toHaveValue(
      "Elite Law LLP",
    );
    expect(
      screen.queryByRole("button", { name: "Delete organization" }),
    ).not.toBeInTheDocument();
  });

  it("turns a member away, with nothing to change and a way back", async () => {
    mocks.role = "member";
    const user = userEvent.setup();
    renderPage();

    expect(
      await screen.findByText(
        "Only this organization's owners and admins can open its settings.",
      ),
    ).toBeInTheDocument();
    // Neither the providers nor the name controls are mounted at all.
    expect(screen.queryByTestId("provider-keys")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "General" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Rename/ }),
    ).not.toBeInTheDocument();

    // The breadcrumb offers the same way back; this is the message's own.
    const notice = document.querySelector<HTMLElement>(
      '[data-slot="empty-state"]',
    )!;
    await user.click(
      within(notice).getByRole("button", { name: "Back to Elite Law LLP" }),
    );
    expect(mocks.push).toHaveBeenCalledWith("/organizations/org-1");
  });

  it("offers nothing to press until the caller's role is known", () => {
    mocks.getOrg.mockReturnValue(new Promise(() => {}));
    renderPage();

    expect(
      within(general()).getByRole("button", { name: /^Rename/ }),
    ).toBeDisabled();
    expect(screen.queryByLabelText("Organization name")).not.toBeInTheDocument();
  });

  it("says so when the organization cannot be loaded, and retries", async () => {
    const user = userEvent.setup();
    mocks.getOrg.mockRejectedValueOnce(new Error("network down"));
    renderPage();

    expect(
      await screen.findByText("Could not load this organization."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/network down/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("provider-keys")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await within(general()).findByText("Elite Law LLP"),
    ).toBeInTheDocument();
  });
});

describe("the organization's name and deletion", () => {
  it("renames the organization and tells the sidebar", async () => {
    const user = userEvent.setup();
    mocks.updateOrg.mockResolvedValue({
      id: "org-1",
      name: "Elite Law Group",
      created_by: "me",
      role: "owner",
    });
    renderPage();

    await openDetails(user);
    const nameInput = screen.getByLabelText("Organization name");
    await user.clear(nameInput);
    await user.type(nameInput, "Elite Law Group");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.updateOrg).toHaveBeenCalledExactlyOnceWith(
      "org-1",
      "Elite Law Group",
    );
    expect(
      await within(general()).findByText("Elite Law Group"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByLabelText("Organization name")).not.toBeInTheDocument(),
    );
    expect(mocks.refreshOrganizations).toHaveBeenCalledTimes(1);
  });

  it("leaves for the organizations list once the organization is deleted", async () => {
    const user = userEvent.setup();
    mocks.deleteOrg.mockResolvedValue(undefined);
    renderPage();

    await openDetails(user);
    await user.click(
      screen.getByRole("button", { name: "Delete organization" }),
    );
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith("/organizations"),
    );
    expect(mocks.deleteOrg).toHaveBeenCalledExactlyOnceWith("org-1");
    expect(mocks.refreshOrganizations).toHaveBeenCalledTimes(1);
  });

  it("spends Escape on the delete confirmation before the details dialog", async () => {
    const user = userEvent.setup();
    renderPage();

    await openDetails(user);
    const nameInput = screen.getByLabelText("Organization name");
    await user.clear(nameInput);
    await user.type(nameInput, "Elite Law Group");
    await user.click(
      screen.getByRole("button", { name: "Delete organization" }),
    );
    expect(screen.getByText("Delete Elite Law LLP?")).toBeInTheDocument();

    // Both layers answered Escape, so declining the delete also closed the
    // dialog and threw away the rename typed above it. The confirmation is
    // on top, so it alone takes the first press.
    await user.keyboard("{Escape}");

    expect(screen.queryByText("Delete Elite Law LLP?")).not.toBeInTheDocument();
    expect(mocks.deleteOrg).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Organization name")).toHaveValue(
      "Elite Law Group",
    );

    // With the confirmation gone the next press belongs to the dialog.
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByLabelText("Organization name")).not.toBeInTheDocument(),
    );
  });

  it("retires the delete confirmation when its dialog closes", async () => {
    // The confirmation renders in its own portal, so closing the dialog by
    // other means must take it down too: otherwise it keeps floating over
    // the page with a live Delete button still wired to this org.
    const user = userEvent.setup();
    renderPage();

    await openDetails(user);
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
});
