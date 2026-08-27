import { expect, test } from "@playwright/test";

test("live backend exposes the authenticated Gmail status route", async ({ page }) => {
    await page.goto("/settings/features");
    const result = await page.evaluate(async () => {
        const token = window.localStorage.getItem("mike_auth_token");
        const response = await fetch("http://localhost:3001/integrations/gmail/status", {
            headers: { Authorization: `Bearer ${token}` },
        });
        return {
            status: response.status,
            contentType: response.headers.get("content-type"),
            body: await response.json(),
        };
    });

    expect(result.status).toBe(200);
    expect(result.contentType).toContain("application/json");
    expect(result.body).toEqual(expect.objectContaining({
        available: expect.any(Boolean),
        enabled: expect.any(Boolean),
        connected: expect.any(Boolean),
    }));
});

test("configured Gmail integration is visible and connected in account features", async ({ page }) => {
    await page.route("http://localhost:3001/user/profile", (route) =>
        route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
                displayName: "E2E User",
                organisation: null,
                messageCreditsUsed: 0,
                creditsResetDate: "2026-08-30T00:00:00.000Z",
                creditsRemaining: 999999,
                tier: "Free",
                titleModel: "gemini-3.1-flash-lite-preview",
                tabularModel: "gemini-3-flash-preview",
                mfaOnLogin: false,
                legalResearchUs: true,
                emailIntegrationEnabled: true,
                apiKeyStatus: {
                    claude: false,
                    kimi: false,
                    gemini: false,
                    openai: false,
                    openrouter: false,
                    courtlistener: false,
                    sources: {},
                },
            }),
        }),
    );
    await page.route("http://localhost:3001/integrations/gmail/status", (route) =>
        route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
                available: true,
                enabled: true,
                connected: true,
                email: "legal@example.com",
            }),
        }),
    );

    await page.goto("/settings/features");

    await expect(page.getByRole("heading", { name: "Email Integration" })).toBeVisible();
    await expect(page.getByText("legal@example.com")).toBeVisible();
    const disconnect = page.getByRole("button", { name: "Disconnect" });
    await expect(disconnect).toBeEnabled();
    await disconnect.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "/tmp/mike-gmail-features.png", fullPage: true });
});
