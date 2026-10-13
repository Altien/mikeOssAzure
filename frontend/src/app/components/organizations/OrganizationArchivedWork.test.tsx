import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { OrganizationArchivedWork } from "./OrganizationArchivedWork";
const mocks = vi.hoisted(() => ({ list: vi.fn(), members: vi.fn(), recover: vi.fn(), remove: vi.fn() }));
vi.mock("@/app/lib/mikeApi", async (original) => ({
    ...await original<typeof import("@/app/lib/mikeApi")>(),
    listOrgDepartureArchives: mocks.list, listOrgMembers: mocks.members,
    recoverOrgDepartureArchive: mocks.recover, deleteOrgDepartureArchive: mocks.remove,
}));
vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({ MfaVerificationPopup: () => null }));
const item = { id: "archive", item_id: "p", kind: "project", title: "Private matter", expires_at: "2026-11-12T00:00:00Z" };
let intersect: IntersectionObserverCallback;
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IntersectionObserver", class {
        constructor(callback: IntersectionObserverCallback) { intersect = callback; }
        observe() {} disconnect() {}
    });
    mocks.list.mockResolvedValue({ items: [item], nextOffset: null });
    mocks.members.mockResolvedValue([
        { user_id: "owner", display_name: "Dana", email: "dana@example.test", role: "owner" },
        { user_id: "member", display_name: "Sam", email: "sam@example.test", role: "member" },
    ]);
    mocks.recover.mockResolvedValue(undefined); mocks.remove.mockResolvedValue(undefined);
});
it("recovers to a selected member and refreshes the archive list", async () => {
    const user = userEvent.setup(); render(<OrganizationArchivedWork orgId="org" />);
    await user.click(await screen.findByRole("button", { name: "Recover Private matter" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("Assign recovered work to")).toHaveTextContent("Dana (dana@example.test)");
    await user.click(within(dialog).getByLabelText("Assign recovered work to"));
    await user.click(screen.getByRole("menuitem", { name: "Sam (sam@example.test)" }));
    mocks.list.mockResolvedValue({ items: [], nextOffset: null });
    await user.click(within(dialog).getByRole("button", { name: "Recover" }));
    await screen.findByText("No archived work.");
    expect(mocks.recover).toHaveBeenCalledWith("org", "archive", "member");
});
it("requires confirmation before permanent deletion", async () => {
    const user = userEvent.setup(); render(<OrganizationArchivedWork orgId="org" />);
    await user.click(await screen.findByRole("button", { name: "Delete Private matter" }));
    expect(mocks.remove).not.toHaveBeenCalled();
    mocks.list.mockResolvedValue({ items: [], nextOffset: null });
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await screen.findByText("No archived work.");
    expect(mocks.remove).toHaveBeenCalledWith("org", "archive");
});
it("retries a failed roster request without losing the archive list", async () => {
    mocks.members.mockRejectedValueOnce(new Error("raw database error"));
    const user = userEvent.setup(); render(<OrganizationArchivedWork orgId="org" />);
    await screen.findByText("Could not load organization members.");
    expect(screen.getByRole("button", { name: "Recover Private matter" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Recover Private matter" })).toBeEnabled());
});
it("loads the next page when the scroll sentinel becomes visible", async () => {
    mocks.list.mockResolvedValueOnce({ items: [item], nextOffset: 50 });
    mocks.list.mockResolvedValueOnce({ items: [{ ...item, id: "next", title: "Next matter" }], nextOffset: null });
    render(<OrganizationArchivedWork orgId="org" />);
    await screen.findByText("Private matter");
    act(() => intersect([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver));
    await screen.findByText("Next matter");
    expect(screen.getByText("Private matter")).toBeVisible();
    expect(mocks.list).toHaveBeenCalledWith("org", 50);
});
it("keeps recovery failures in the modal for retry", async () => {
    mocks.recover.mockRejectedValueOnce(new Error("raw database error"));
    const user = userEvent.setup(); render(<OrganizationArchivedWork orgId="org" />);
    await user.click(await screen.findByRole("button", { name: "Recover Private matter" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Recover" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not recover this work.");
    expect(screen.getByRole("dialog")).toBeVisible();
});
