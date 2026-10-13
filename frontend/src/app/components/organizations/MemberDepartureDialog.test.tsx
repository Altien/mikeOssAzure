import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OrgMember } from "@/app/lib/mikeApi";
import { MemberDepartureDialog } from "./MemberDepartureDialog";

// What becomes of a member's work when they leave an organization: the
// private projects and workflows they alone own go to a member named here,
// and their own standalone chats and reviews are deleted. The dialog says
// so before anything happens, and will not go on without a successor when
// one is needed.

const mocks = vi.hoisted(() => ({
  getOrgMemberHandover: vi.fn(),
  listOrgMembers: vi.fn(),
  removeOrgMember: vi.fn(),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getOrgMemberHandover: mocks.getOrgMemberHandover,
  listOrgMembers: mocks.listOrgMembers,
  removeOrgMember: mocks.removeOrgMember,
}));

const member = (
  user_id: string,
  display_name: string | null,
  role: OrgMember["role"] = "member",
): OrgMember => ({
  id: `m-${user_id}`,
  user_id,
  role,
  display_name,
  email: `${user_id}@firm.example`,
});
const ROSTER = [
  member("dana", "Dana Owner", "owner"),
  member("sam", "Sam Leaver"),
  member("robin", "Robin Heir"),
  member("pat", null),
];
const NOTHING = { projects: [], workflows: [], chats: 0, reviews: 0 };
const SAMS_WORK = {
  projects: [
    { id: "p1", title: "Project Atlas" },
    { id: "p2", title: "" },
  ],
  workflows: [{ id: "w1", title: "Disclosure checklist" }],
  chats: 2,
  reviews: 1,
};

const onCancel = vi.fn();
const onDone = vi.fn();
const renderDialog = (
  props: Partial<Parameters<typeof MemberDepartureDialog>[0]> = {},
) =>
  render(
    <MemberDepartureDialog
      orgId="org-1"
      departing={[ROSTER[1]]}
      members={ROSTER}
      onCancel={onCancel}
      onDone={onDone}
      {...props}
    />,
  );
const confirmButton = (name = "Remove") =>
  within(screen.getByRole("dialog")).getByRole("button", { name });
const chooseSuccessor = async (
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) => {
  await user.click(screen.getByLabelText("Hand over to"));
  await user.click(await screen.findByRole("menuitem", { name }));
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOrgMemberHandover.mockResolvedValue(NOTHING);
  mocks.listOrgMembers.mockResolvedValue(ROSTER);
  mocks.removeOrgMember.mockResolvedValue(undefined);
});

describe("a member with nothing of their own", () => {
  it("is removed on confirmation, with nobody asked for", async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(
      screen.getByText("Sam Leaver will lose organization access."),
    ).toBeInTheDocument();
    // Not before the answer is in: a removal that turned out to need a
    // successor must not have been sent already.
    expect(confirmButton()).toBeDisabled();
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    expect(screen.queryByLabelText("Hand over to")).not.toBeInTheDocument();
    expect(screen.queryByText(/permanently deleted/)).not.toBeInTheDocument();

    await user.click(confirmButton());
    await waitFor(() =>
      expect(onDone).toHaveBeenCalledWith({
        removedUserIds: ["sam"],
        error: null,
      }),
    );
    expect(mocks.removeOrgMember).toHaveBeenCalledExactlyOnceWith(
      "org-1",
      "sam",
      undefined,
    );
  });
});

describe("a member who alone owns projects and workflows", () => {
  beforeEach(() => {
    mocks.getOrgMemberHandover.mockResolvedValue(SAMS_WORK);
  });

  it("says what has to be handed over, and what will be deleted", async () => {
    renderDialog();

    expect(
      await screen.findByText(
        "Sam Leaver is the only owner of 2 projects and 1 workflow. Choose who takes them over.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Project Atlas")).toBeInTheDocument();
    expect(screen.getByText("Disclosure checklist")).toBeInTheDocument();
    // A project with no name is still listed.
    expect(screen.getByText("Untitled")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Sam Leaver's 2 private chats and 1 tabular review in this organization will be permanently deleted.",
      ),
    ).toBeInTheDocument();
  });

  it("will not remove them until a successor is chosen", async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByLabelText("Hand over to");

    expect(confirmButton()).toBeDisabled();
    await user.click(confirmButton());
    expect(mocks.removeOrgMember).not.toHaveBeenCalled();
  });

  it("offers the organization's other members, never the one who is going", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByLabelText("Hand over to"));

    const options = (await screen.findAllByRole("menuitem")).map(
      (option) => option.textContent,
    );
    // A member with no name is offered by their address.
    expect(options).toEqual(["Dana Owner", "Robin Heir", "pat@firm.example"]);
  });

  it("hands the work to the chosen member as it removes them", async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByLabelText("Hand over to");

    await chooseSuccessor(user, "Robin Heir");
    // Two members can share a name: the address says which one this is.
    expect(screen.getByText("robin@firm.example")).toBeInTheDocument();
    await user.click(confirmButton());

    await waitFor(() =>
      expect(mocks.removeOrgMember).toHaveBeenCalledExactlyOnceWith(
        "org-1",
        "sam",
        "robin",
      ),
    );
    expect(onDone).toHaveBeenCalledWith({
      removedUserIds: ["sam"],
      error: null,
    });
  });

  it("reports a removal the server refused, and removes nobody from the page", async () => {
    const user = userEvent.setup();
    const refusal = new Error("An organization must keep at least one owner.");
    mocks.removeOrgMember.mockRejectedValue(refusal);
    renderDialog();
    await screen.findByLabelText("Hand over to");
    await chooseSuccessor(user, "Dana Owner");
    await user.click(confirmButton());

    await waitFor(() =>
      expect(onDone).toHaveBeenCalledWith({
        removedUserIds: [],
        error: refusal,
      }),
    );
  });

  it("says so when there is nobody to hand it to", async () => {
    renderDialog({ members: [ROSTER[1]] });

    expect(
      await screen.findByText("There is no other member to hand this to."),
    ).toBeInTheDocument();
    expect(confirmButton()).toBeDisabled();
  });

  it("counts the titles it does not list", async () => {
    mocks.getOrgMemberHandover.mockResolvedValue({
      ...NOTHING,
      projects: Array.from({ length: 9 }, (_, index) => ({
        id: `p${index}`,
        title: `Matter ${index + 1}`,
      })),
    });
    renderDialog();

    expect(await screen.findByText("Matter 6")).toBeInTheDocument();
    expect(screen.queryByText("Matter 7")).not.toBeInTheDocument();
    expect(screen.getByText("and 3 more")).toBeInTheDocument();
  });
});

describe("leaving", () => {
  it("speaks to the member, and lets them name their own successor", async () => {
    const user = userEvent.setup();
    mocks.getOrgMemberHandover.mockResolvedValue({
      ...NOTHING,
      workflows: [{ id: "w1", title: "Disclosure checklist" }],
      chats: 1,
    });
    // Opened from settings, which has no roster of its own to pass.
    renderDialog({ leaving: true, members: undefined });

    expect(
      screen.getByText(
        "You will lose access to this organization's shared resources.",
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        "You are the only owner of 1 workflow. Choose who takes it over.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your 1 private chat in this organization will be permanently deleted.",
      ),
    ).toBeInTheDocument();
    expect(mocks.listOrgMembers).toHaveBeenCalledWith("org-1");

    await chooseSuccessor(user, "Dana Owner");
    await user.click(confirmButton("Leave"));
    await waitFor(() =>
      expect(mocks.removeOrgMember).toHaveBeenCalledWith(
        "org-1",
        "sam",
        "dana",
      ),
    );
  });
});

describe("removing several members together", () => {
  it("hands all of their work to one successor, who is none of them", async () => {
    const user = userEvent.setup();
    mocks.getOrgMemberHandover.mockImplementation(
      async (_orgId: string, userId: string) =>
        userId === "sam"
          ? { ...NOTHING, projects: [{ id: "p1", title: "Project Atlas" }] }
          : { ...NOTHING, workflows: [{ id: "w1", title: "Checklist" }] },
    );
    renderDialog({ departing: [ROSTER[1], ROSTER[2]] });

    expect(
      screen.getByText(
        "2 selected members will lose access to this organization.",
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        "These members are the only owners of 1 project and 1 workflow. Choose who takes them over.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByLabelText("Hand over to"));
    expect(
      (await screen.findAllByRole("menuitem")).map((o) => o.textContent),
    ).toEqual(["Dana Owner", "pat@firm.example"]);
    await user.click(screen.getByRole("menuitem", { name: "Dana Owner" }));
    await user.click(confirmButton());

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(mocks.removeOrgMember.mock.calls).toEqual([
      ["org-1", "sam", "dana"],
      ["org-1", "robin", "dana"],
    ]);
  });

  it("reports who went and the first refusal when only some could be removed", async () => {
    const user = userEvent.setup();
    const refusal = new Error("Only an organization owner can do that.");
    mocks.removeOrgMember.mockImplementation(
      async (_orgId: string, userId: string) => {
        if (userId === "robin") throw refusal;
      },
    );
    renderDialog({ departing: [ROSTER[1], ROSTER[2]] });
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    await user.click(confirmButton());

    await waitFor(() =>
      expect(onDone).toHaveBeenCalledWith({
        removedUserIds: ["sam"],
        error: refusal,
      }),
    );
  });
});

describe("when what would be handed over cannot be read", () => {
  it("says so and removes nobody", async () => {
    const user = userEvent.setup();
    mocks.getOrgMemberHandover.mockRejectedValue(new Error("offline"));
    renderDialog();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not check what would be handed over.",
    );
    expect(confirmButton()).toBeDisabled();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect(onCancel).toHaveBeenCalled();
    expect(mocks.removeOrgMember).not.toHaveBeenCalled();
  });
});
