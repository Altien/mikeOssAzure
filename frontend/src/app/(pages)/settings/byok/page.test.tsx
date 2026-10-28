import { describe, expect, it } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw-server";
import { renderWithProviders } from "@/test/render";
import { UserProfileProvider } from "@/app/contexts/UserProfileContext";
import ApiKeysPage from "./page";

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
    it("changes only a personal enablement preference and keeps the configured card", async () => {
        let body: unknown;
        server.use(
            http.get("*/api/user/profile", () => HttpResponse.json(profileWith(STATUS))),
            http.patch("*/api/user/api-keys/claude", async ({ request }) => {
                body = await request.json();
                return HttpResponse.json({ ...STATUS, claude: false, enabled: { claude: false } });
            }),
        );
        const user = userEvent.setup();
        renderPage();
        const toggle = await screen.findByRole("switch", { name: "Anthropic (Claude) provider" });
        await user.click(toggle);
        expect(body).toEqual({ enabled: false });
        await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
        expect(within(screen.getByRole("region", { name: "Configured Providers" }))
            .getByRole("button", { name: "Manage Anthropic (Claude)" })).toBeInTheDocument();
    });
});
