import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw-server";
import { renderWithProviders } from "@/test/render";
import { UserProfileProvider } from "@/app/contexts/UserProfileContext";
import FeaturesPage from "./page";

function renderPage() {
    return renderWithProviders(
        <UserProfileProvider>
            <FeaturesPage />
        </UserProfileProvider>,
        { user: { id: "user-1", email: "user@example.com" } },
    );
}

describe("CourtListener organisation credential", () => {
    it("shows read-only organisation status instead of personal key controls", async () => {
        server.use(
            http.get("*/api/user/profile", () =>
                HttpResponse.json({
                    displayName: null,
                    organisation: null,
                    messageCreditsUsed: 0,
                    creditsResetDate: new Date(
                        Date.now() + 86_400_000,
                    ).toISOString(),
                    creditsRemaining: 999999,
                    tier: "Free",
                    titleModel: "",
                    tabularModel: "gemini-3-flash-preview",
                    mfaOnLogin: false,
                    legalResearchUs: true,
                    apiKeyStatus: {
                        courtlistener: false,
                        sources: { courtlistener: null },
                    },
                }),
            ),
        );

        renderPage();

        expect(
            await screen.findByText("Administrator action required"),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("link", { name: "Open organisation setup" }),
        ).toHaveAttribute("href", expect.stringContaining("/install"));
        expect(
            screen.queryByPlaceholderText("Token..."),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: /^Save$/ }),
        ).not.toBeInTheDocument();
    });
});
