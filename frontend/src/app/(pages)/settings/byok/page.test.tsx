import { describe, expect, it, vi } from "vitest";

const { captureRequestOwner } = vi.hoisted(() => ({ captureRequestOwner: vi.fn(() => () => true) }));
vi.mock("@/app/hooks/useRequestOwner", () => ({ useRequestOwner: () => ({ capture: captureRequestOwner}) }));
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw-server";
import { renderWithProviders } from "@/test/render";
import { UserProfileProvider } from "@/app/contexts/UserProfileContext";
import ApiKeysPage from "./page";

// The page sends an organization's owners and admins to its own settings.
vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace: vi.fn() }),
}));

function profileWith(apiKeyStatus: Record<string, unknown>) {
    return {
        displayName: null, organisation: null, messageCreditsUsed: 0,
        creditsResetDate: new Date(Date.now() + 86_400_000).toISOString(),
        creditsRemaining: 999999, tier: "Free", titleModel: "",
        tabularModel: "gemini-3-flash-preview", mfaOnLogin: false,
        legalResearchUs: true, apiKeyStatus,
    };
}
const STATUS = {
    claude: true, gemini: false, openai: true, kimi: true,
    openrouter: false, courtlistener: false, azure_openai: false,
    sources: { claude: "env", gemini: null, openai: "env", kimi: "env",
        openrouter: null, courtlistener: null, azure_openai: null },
    enabled: {},
};
function renderPage() {
    return renderWithProviders(
        <UserProfileProvider><ApiKeysPage /></UserProfileProvider>,
        { user: { id: "user-1", email: "user@example.com" } },
    );
}
describe("organisation model providers", () => {
    // Upstream 25779536 adopts cards/modals; credentials stay managed by the organisation.
    it("opens provider management without exposing personal key controls", async () => {
        server.use(http.get("*/api/user/profile", () => HttpResponse.json(profileWith(STATUS))));
        const user = userEvent.setup();
        renderPage();
        expect(await screen.findByRole("button", { name: "Manage Anthropic (Claude)" })).toBeVisible();
        expect(screen.getByText("Kimi K3")).toBeInTheDocument();
        expect(screen.getByText("Mistral AI")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Manage Anthropic (Claude)" }));
        expect(screen.getByRole("link", { name: "Open organisation setup" }))
            .toHaveAttribute("href", expect.stringContaining("/install"));
        expect(screen.getByText(/Credentials are shared by this organisation/)).toBeVisible();
        expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /^Save$/ })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /^Clear$/ })).not.toBeInTheDocument();
    });
    it("shows TokenJuice and Meta read-only: status, a route to /install, no key input or switch", async () => {
        server.use(http.get("*/api/user/profile", () => HttpResponse.json(profileWith({
            ...STATUS,
            tokenjuice: true,
            meta: false,
            sources: { ...STATUS.sources, tokenjuice: "env", meta: null },
        }))));
        const user = userEvent.setup();
        renderPage();
        const manage = await screen.findByRole("button", { name: "Manage TokenJuice" });
        expect(screen.queryByRole("switch", { name: "TokenJuice provider" })).not.toBeInTheDocument();
        expect(screen.getByText("Configured")).toBeInTheDocument();
        await user.click(manage);
        expect(screen.getByRole("link", { name: "Open organisation setup" }))
            .toHaveAttribute("href", expect.stringContaining("/install"));
        expect(screen.queryByRole("switch", { name: "Use TokenJuice" })).not.toBeInTheDocument();
        expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
        expect(document.querySelector('input[type="password"]')).toBeNull();
        expect(screen.queryByRole("button", { name: /^Save$/ })).not.toBeInTheDocument();
    });
    it("offers Meta's route to /install while it is not configured, with no key input", async () => {
        server.use(http.get("*/api/user/profile", () => HttpResponse.json(profileWith(STATUS))));
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Add Meta (Muse)" }));
        expect(screen.getByRole("link", { name: "Open organisation setup" }))
            .toHaveAttribute("href", expect.stringContaining("/install"));
        expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
        expect(document.querySelector('input[type="password"]')).toBeNull();
    });
    it("changes only a personal enablement preference and keeps the configured card", async () => {
        let body: unknown;
        server.use(
            http.get("*/api/user/profile", () => HttpResponse.json(profileWith(STATUS))),
            http.patch("*/api/user/api-keys/claude", async ({ request }) => {
                body = await request.json();
                return HttpResponse.json({ ...STATUS, enabled: { claude: false } });
            }),
        );
        const user = userEvent.setup();
        renderPage();
        const toggle = await screen.findByRole("switch", { name: "Anthropic (Claude) provider" });
        await user.click(toggle);
        expect(body).toEqual({ enabled: false });
        await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
        expect(within(screen.getByRole("region", { name: "Available Providers" }))
            .getByRole("button", { name: "Manage Anthropic (Claude)" })).toBeInTheDocument();
    });
});

describe("pooled organisation providers", () => {
    const pooled = (claudeKeySet: boolean) => ({
        ...STATUS,
        pooledKeys: {
            claude: { memberKeyModels: ["claude-sonnet-4-5"], memberKeySet: claudeKeySet, organisationKey: false },
            openai: { memberKeyModels: [], memberKeySet: false, organisationKey: true },
        },
    });
    it("shows who supplies each key and saves a member key only where enabled, with no /install route", async () => {
        let saved = false;
        let body: unknown;
        server.use(
            http.get("*/api/user/profile", () => HttpResponse.json(profileWith(pooled(saved)))),
            http.put("*/api/user/api-keys/claude", async ({ request }) => {
                body = await request.json();
                saved = true;
                return HttpResponse.json(pooled(true));
            }),
        );
        const user = userEvent.setup();
        renderPage();
        expect(await screen.findByText(/You may use your own key for: claude-sonnet-4-5/)).toBeVisible();
        const claude = screen.getByRole("region", { name: "Anthropic (Claude) provider" });
        expect(within(screen.getByRole("region", { name: "OpenAI provider" }))
            .getByText(/Provided by your organisation/)).toBeVisible();
        expect(within(screen.getByRole("region", { name: "Mistral AI provider" }))
            .getByText(/managed by your organisation's administrators/)).toBeVisible();
        expect(screen.queryByRole("link", { name: "Open organisation setup" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /^Add / })).not.toBeInTheDocument();
        expect(screen.queryByText(/Personal workspace only/)).not.toBeInTheDocument();
        expect(screen.getAllByLabelText(/API key$/)).toHaveLength(1);

        await user.type(within(claude).getByLabelText("Anthropic (Claude) API key"), "sk-member");
        await user.click(within(claude).getByRole("button", { name: "Save" }));
        expect(body).toEqual({ api_key: "sk-member" });
        expect(await within(claude).findByRole("button", { name: "Remove your Anthropic (Claude) key" })).toBeVisible();
    });
});
