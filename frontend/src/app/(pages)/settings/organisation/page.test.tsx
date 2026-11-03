import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import type { TenantAdminOverview } from "@mike/contracts";
import OrganisationPage from "./page";

const api = vi.hoisted(() => ({
    status: vi.fn(),
    overview: vi.fn(),
    content: vi.fn(),
    reassign: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", () => ({
    getTenantAdminStatus: api.status,
    getTenantAdminOverview: api.overview,
    getTenantAdminContent: api.content,
    reassignTenantContent: api.reassign,
    INTERNAL_ERROR_MESSAGE: "Something went wrong. Please try again.",
    MikeApiError: class MikeApiError extends Error {},
}));

const overview: TenantAdminOverview = {
    tenantId: "tenant-a",
    controlPlaneUrl: "https://control.example.test/members",
    members: [
        { userId: "owner", displayName: "Alex Morgan", email: "alex.morgan@example.test", role: "Member" },
        { userId: "admin", displayName: "Sam Lee", email: "sam.lee@example.test", role: "TenantAdmin" },
    ],
    usage: {
        periodStart: "2026-10-01",
        totalTokens: 1234,
        totalCredits: "1.23456789",
        byUser: [{ userId: "owner", totalTokens: 1234, totalCredits: "1.23456789" }],
    },
    budget: {
        monthlyCredits: "100",
        perUserCredits: null,
        softThreshold: "0.8",
        usedCredits: "1.23456789",
        reservedCredits: "2",
    },
};
const matter = {
    id: "matter-a",
    kind: "project" as const,
    title: "Matter A",
    ownerId: "owner",
    createdAt: "2026-10-01T12:00:00Z",
};

function renderPage(tenancyMode: "single" | "pooled" = "pooled") {
    return renderWithProviders(<OrganisationPage />, {
        config: { tenancyMode },
        user: { id: "admin", email: "sam.lee@example.test" },
    });
}

describe("Organisation settings", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        api.status.mockResolvedValue({ isTenantAdmin: true });
        api.overview.mockResolvedValue(overview);
        api.content.mockResolvedValue({ items: [matter], hasMore: false });
        api.reassign.mockResolvedValue({ ok: true });
    });

    it("keeps single-tenant settings unchanged and does not request admin data", () => {
        renderPage("single");
        expect(screen.getByText("Organisation administration is available to tenant admins.")).toBeVisible();
        expect(api.status).not.toHaveBeenCalled();
        expect(api.overview).not.toHaveBeenCalled();
    });

    it("denies Members without loading content or usage", async () => {
        api.status.mockResolvedValue({ isTenantAdmin: false });
        renderPage();
        expect(await screen.findByText("Organisation administration is available to tenant admins.")).toBeVisible();
        expect(api.overview).not.toHaveBeenCalled();
        expect(api.content).not.toHaveBeenCalled();
    });

    it("shows members, precise credits, budget and the external member-management link", async () => {
        renderPage();
        expect(await screen.findByRole("link", { name: "Matter A" })).toHaveAttribute("href", "/projects/matter-a");
        expect(screen.getByText("alex.morgan@example.test")).toBeVisible();
        expect(screen.getByText("Tenant admin")).toBeVisible();
        expect(screen.getByText("No limit")).toBeVisible();
        expect(screen.getAllByText("1.23456789 credits")).toHaveLength(2);
        expect(screen.getByRole("link", { name: "Manage members in the control plane" })).toHaveAttribute("href", overview.controlPlaneUrl);
    });

    it("requires a different same-tenant member and an audit reason before reassigning", async () => {
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Reassign Matter A" }));
        const confirm = screen.getByRole("button", { name: "Confirm reassignment" });
        expect(confirm).toBeDisabled();
        await user.click(screen.getByRole("button", { name: /New owner Choose a member/ }));
        expect(screen.queryByRole("menuitemradio", { name: /Alex Morgan/ })).not.toBeInTheDocument();
        await user.click(screen.getByRole("menuitemradio", { name: /Sam Lee/ }));
        expect(confirm).toBeDisabled();
        await user.type(screen.getByLabelText("Reason for reassignment"), "Departed employee");
        await user.click(confirm);
        await waitFor(() => expect(api.reassign).toHaveBeenCalledWith({
            kind: "project", id: "matter-a", newOwnerId: "admin", reason: "Departed employee",
        }));
        expect(await screen.findByText("Ownership reassigned.")).toBeVisible();
        await waitFor(() => expect(api.content).toHaveBeenCalledTimes(2));
    });

    it("pages content and resets pagination when its kind changes", async () => {
        const user = userEvent.setup();
        api.content.mockResolvedValue({ items: [matter], hasMore: true });
        renderPage();
        await screen.findByRole("link", { name: "Matter A" });
        await user.click(screen.getByRole("button", { name: "Next" }));
        await waitFor(() => expect(api.content).toHaveBeenLastCalledWith("project", 50, 50));
        await user.click(screen.getByRole("button", { name: "Chats" }));
        await waitFor(() => expect(api.content).toHaveBeenLastCalledWith("chat", 0, 50));
        expect(screen.getByRole("button", { name: "Chats" })).toHaveAttribute("aria-pressed", "true");
    });

    it("hides raw provider errors and permits retrying a failed content read", async () => {
        const user = userEvent.setup();
        api.content.mockRejectedValueOnce(new Error("database password exposed"));
        renderPage();
        expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong. Please try again.");
        expect(screen.queryByText(/database password/)).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findByRole("link", { name: "Matter A" })).toBeVisible();
    });
});
