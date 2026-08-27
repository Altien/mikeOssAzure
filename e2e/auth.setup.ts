import { test as setup, expect } from "@playwright/test";
import path from "path";
import fs from "fs";
import { completeOnboardingIfRequired } from "./onboarding";

const authFile = path.join(__dirname, ".auth/user.json");

async function ensureUser(email: string, password: string) {
    const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

    const res = await fetch(`${apiBase}/user/auth/signup`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password }),
    });

    if (!res.ok && res.status !== 409) {
        const body = await res.text();
        throw new Error(`Failed to create user ${email}: ${res.status} ${body}`);
    }
}

/**
 * The main authenticated session shared by every non-destructive test.
 * Stored to e2e/.auth/user.json and loaded via the chromium project config.
 */
setup("authenticate", async ({ page }) => {
    // Default to the credentials the spec files use (the specs log in with
    // e2e@mike.local / E2eTestPass1!), so the suite runs out-of-the-box against
    // a local stack with no env juggling. The bootstrapped user MUST match the
    // password the specs type, or the valid-login tests fail; keeping the
    // default here is the single source of truth. Override via env in CI.
    const email = process.env.E2E_EMAIL ?? "e2e@mike.local";
    const password = process.env.E2E_PASSWORD ?? "E2eTestPass1!";

    /* Bootstrap the shared user plus a dedicated user for destructive auth
       tests such as account deletion. Isolating destructive flows from the
       shared cookie session keeps parallel workers stable. */
    await ensureUser(email, password);
    await ensureUser(
        process.env.E2E_LOGOUT_EMAIL ?? "e2e-logout@mike.local",
        process.env.E2E_LOGOUT_PASSWORD ?? "E2eLogoutPass1!",
    );

    await page.goto("/login");
    await expect(page).toHaveURL(/\/login/);

    await page.fill("#email", email);
    await page.fill("#password", password);
    await page.click('button[type="submit"]');

    /* New fixture users must complete the onboarding lifecycle before their
       shared authenticated state can be used by the rest of the suite. On
       later runs the already-onboarded user goes directly to /assistant. */
    await completeOnboardingIfRequired(page);

    /* Save the authenticated session for all subsequent tests */
    await page.context().storageState({ path: authFile });
});
