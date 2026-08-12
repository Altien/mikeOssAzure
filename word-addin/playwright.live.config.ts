import { defineConfig, devices } from "@playwright/test";

/**
 * LIVE full-stack demo config — the opposite trade-off to playwright.config.ts.
 *
 * Nothing is mocked except the Word JS API surface (a real browser has no
 * Office.js host): sign-in goes to the real local Supabase, chat and actions
 * stream from the real Mike backend and a real LLM. Prerequisites:
 *   - webpack dev server on https://localhost:3000 (proxies /auth + /api)
 *   - Mike backend on :3001 with a real ANTHROPIC_API_KEY
 *   - local Supabase with a seeded demo user
 *
 * Runs record video ("on") — these are demo reels as much as tests. LLM turns
 * dominate wall-clock, hence the generous timeouts and strictly serial runs.
 */
export default defineConfig({
  testDir: "./e2e-live",
  fullyParallel: false,
  workers: 1,
  timeout: 300_000,
  expect: { timeout: 120_000 },
  reporter: "list",

  use: {
    baseURL: "https://localhost:3000",
    ignoreHTTPSErrors: true,
    screenshot: "only-on-failure",
    video: "on",
    launchOptions: {
      // The dev server's cert is intentionally untrusted (no keychain CA in
      // automated environments); Chromium must tolerate it at the TLS layer.
      args: ["--ignore-certificate-errors"],
      // Human-paced input so the recorded videos are watchable as demos.
      slowMo: 350,
    },
  },

  projects: [
    {
      name: "live-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 480, height: 900 } },
    },
  ],
});
