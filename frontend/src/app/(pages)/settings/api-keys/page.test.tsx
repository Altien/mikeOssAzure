import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw-server";
import { renderWithProviders } from "@/test/render";
import { UserProfileProvider } from "@/app/contexts/UserProfileContext";
import ApiKeysPage from "./page";

// OSS-6: the page reads organisation credential status from the profile
// (`useUserProfile().profile.apiKeys`, served as upstream's `apiKeyStatus`
// by GET /user/profile) instead of calling GET /user/api-keys itself.
function profileWith(apiKeyStatus: Record<string, unknown>) {
    return {
        displayName: null,
        organisation: null,
        messageCreditsUsed: 0,
        creditsResetDate: new Date(Date.now() + 86_400_000).toISOString(),
        creditsRemaining: 999999,
        tier: "Free",
        titleModel: "",
        tabularModel: "gemini-3-flash-preview",
        mfaOnLogin: false,
        legalResearchUs: true,
        apiKeyStatus,
    };
}

const STATUS = {
    claude: true,
    gemini: false,
    openai: true,
    kimi: true,
    openrouter: false,
    courtlistener: false,
    azure_openai: false,
    sources: {
        claude: "env",
        gemini: null,
        openai: "env",
        kimi: "env",
        openrouter: null,
        courtlistener: null,
        azure_openai: null,
    },
};

function renderPage() {
    return renderWithProviders(
        <UserProfileProvider>
            <ApiKeysPage />
        </UserProfileProvider>,
        { user: { id: "user-1", email: "user@example.com" } },
    );
}

describe("organisation API key status", () => {
    it("shows provider status without exposing personal key controls", async () => {
        server.use(
            http.get("*/api/user/profile", () =>
                HttpResponse.json(profileWith(STATUS)),
            ),
        );

        renderPage();

        expect(
            await screen.findAllByText("Configured for this organisation"),
        ).toHaveLength(3);
        expect(screen.getByText("Kimi K3")).toBeInTheDocument();
        expect(screen.getByText("Key Vault: moonshot-api-key")).toBeInTheDocument();
        expect(
            screen.getAllByText("Administrator action required").length,
        ).toBeGreaterThan(0);
        expect(
            screen.getByRole("link", { name: "Open organisation setup" }),
        ).toHaveAttribute("href", expect.stringContaining("/install"));
        expect(screen.queryByPlaceholderText("Token...")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /^Save$/ })).not.toBeInTheDocument();
    });

    // Upstream 93c72a16 removed the page's Refresh button (it only re-detected
    // local Ollama models), so the former "Refresh reloads the profile" test
    // asserts superseded behaviour and is dropped.
});
