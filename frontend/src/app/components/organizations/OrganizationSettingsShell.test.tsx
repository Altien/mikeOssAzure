import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { MikeApiError } from "@/app/lib/mikeApi";
import { OrganizationProvidersSettings } from "./OrganizationProvidersSettings";
import {
  OrganizationSettingsFrame,
  OrganizationSettingsProvider,
  organizationSettingsHref,
  useOrganizationSettings,
} from "./OrganizationSettingsShell";

// The frame around an organization's settings, and the one section in it
// that is not every member's: who is offered which sections, what a member
// who follows a link to Model Providers is told, and what the sections are
// handed.

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  pathname: "/organizations/org-1/settings",
  role: "owner" as "owner" | "admin" | "member",
  getOrg: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  usePathname: () => mocks.pathname,
}));
vi.mock("./OrganizationProviderKeys", () => ({
  OrganizationProviderKeys: ({ orgName }: { orgName: string }) => (
    <div data-testid="provider-keys">{orgName}</div>
  ),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getOrg: mocks.getOrg,
}));

// What a section sees, published from an effect so a test can call it.
let latest: ReturnType<typeof useOrganizationSettings>;
function Section() {
  const value = useOrganizationSettings();
  useEffect(() => {
    latest = value;
  });
  return <p>section for {value.org?.name ?? "…"}</p>;
}

// As the routes compose them: the provider around everything under
// settings, the frame around the pages that sit inside it.
const renderShell = (children = <Section />) =>
  render(
    <OrganizationSettingsProvider orgId="org-1">
      <OrganizationSettingsFrame>{children}</OrganizationSettingsFrame>
    </OrganizationSettingsProvider>,
  );
const sections = () =>
  within(screen.getByRole("navigation", { name: "Organization settings" }))
    .getAllByRole("button")
    .map((button) => button.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pathname = "/organizations/org-1/settings";
  mocks.role = "owner";
  mocks.getOrg.mockImplementation(async () => ({
    id: "org-1",
    name: "Elite Law LLP",
    created_by: "me",
    role: mocks.role,
  }));
});

describe("the sections each role is offered", () => {
  it.each(["owner", "admin"] as const)(
    "offers an %s General, Members and Model Providers",
    async (role) => {
      mocks.role = role;
      renderShell();
      await screen.findByText("section for Elite Law LLP");
      expect(sections()).toEqual(["General", "Members", "Model Providers"]);
    },
  );

  it("offers a member General and Members only", async () => {
    mocks.role = "member";
    renderShell();
    await screen.findByText("section for Elite Law LLP");
    expect(sections()).toEqual(["General", "Members"]);
  });

  it("does not offer Model Providers before the caller's role is known", () => {
    mocks.getOrg.mockReturnValue(new Promise(() => {}));
    renderShell();
    expect(sections()).toEqual(["General", "Members"]);
  });

  it("drops Model Providers as soon as a re-read shows the caller was demoted", async () => {
    renderShell();
    await screen.findByText("section for Elite Law LLP");
    expect(sections()).toContain("Model Providers");

    mocks.role = "member";
    await act(() => latest.reload());

    expect(sections()).toEqual(["General", "Members"]);
  });
});

describe("the frame", () => {
  it("is headed Organization Settings, whichever organization it is", async () => {
    renderShell();
    // Before the organization has loaded, and after.
    expect(
      screen.getByRole("heading", { level: 1, name: "Organization Settings" }),
    ).toBeInTheDocument();
    await screen.findByText("section for Elite Law LLP");
    expect(
      screen.getByRole("heading", { level: 1, name: "Organization Settings" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Elite Law LLP" }),
    ).not.toBeInTheDocument();
  });

  it("marks the open section, and General only on its own page", async () => {
    mocks.pathname = "/organizations/org-1/settings/members";
    renderShell();
    await screen.findByText("section for Elite Law LLP");

    expect(screen.getByRole("button", { name: "Members" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // General's path is a prefix of every section's.
    expect(screen.getByRole("button", { name: "General" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("opens a section by its address", async () => {
    const user = userEvent.setup();
    renderShell();
    await screen.findByText("section for Elite Law LLP");

    await user.click(screen.getByRole("button", { name: "Model Providers" }));

    expect(mocks.push).toHaveBeenCalledWith(
      "/organizations/org-1/settings/providers",
    );
    expect(organizationSettingsHref("org-1")).toBe(
      "/organizations/org-1/settings",
    );
    expect(organizationSettingsHref("org-1", "members")).toBe(
      "/organizations/org-1/settings/members",
    );
  });

  it("lets a section put a renamed organization in place", async () => {
    renderShell();
    await screen.findByText("section for Elite Law LLP");

    act(() => latest.setOrg({ ...latest.org!, name: "Elite Law Group" }));

    expect(screen.getByText("section for Elite Law Group")).toBeInTheDocument();
  });

  it("shares the organization with a page outside the frame, such as Members", async () => {
    // Members is a full table page: inside the provider, not the frame.
    render(
      <OrganizationSettingsProvider orgId="org-1">
        <Section />
      </OrganizationSettingsProvider>,
    );
    expect(
      await screen.findByText("section for Elite Law LLP"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(mocks.getOrg).toHaveBeenCalledExactlyOnceWith("org-1");
  });

  it("tells somebody outside the organization nothing about it, and offers a retry", async () => {
    const user = userEvent.setup();
    mocks.getOrg.mockRejectedValueOnce(
      new MikeApiError({ message: "Organization not found", status: 404 }),
    );
    renderShell();

    expect(
      await screen.findByText("Organization not found"),
    ).toBeInTheDocument();
    // No frame and no sections: there is no area to show.
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByText(/section for/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText("section for Elite Law LLP"),
    ).toBeInTheDocument();
  });

  it("does not show an internal error to the page", async () => {
    mocks.getOrg.mockRejectedValueOnce(new Error("ECONNREFUSED 10.0.0.4"));
    renderShell();
    expect(
      await screen.findByText("Could not load this organization."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument();
  });
});

describe("the Model Providers section", () => {
  it.each(["owner", "admin"] as const)("is an %s's to use", async (role) => {
    mocks.role = role;
    renderShell(<OrganizationProvidersSettings />);
    await waitFor(() =>
      expect(screen.getByTestId("provider-keys")).toHaveTextContent(
        "Elite Law LLP",
      ),
    );
  });

  it("turns a member who follows a link to it away, with a way back", async () => {
    mocks.role = "member";
    const user = userEvent.setup();
    renderShell(<OrganizationProvidersSettings />);

    expect(
      await screen.findByText(
        "Only this organization's owners and admins can manage its model providers.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("provider-keys")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to General" }));
    expect(mocks.push).toHaveBeenCalledWith("/organizations/org-1/settings");
  });
});

describe("the settings title", () => {
  it("is a display heading, one step down from the largest", async () => {
    renderShell();
    const title = screen.getByRole("heading", {
      level: 1,
      name: "Organization Settings",
    });
    expect(title).toHaveClass("text-3xl", "font-medium");
    expect(title).not.toHaveClass("text-4xl");
    await screen.findByText("section for Elite Law LLP");
  });
});
