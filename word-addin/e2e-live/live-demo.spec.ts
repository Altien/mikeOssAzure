/**
 * LIVE full-stack demo of the Word add-in (see playwright.live.config.ts).
 *
 * Real sign-in (local Supabase), real Mike backend, real LLM responses —
 * only the Word JS API is shimmed (a plain browser has no Office host).
 * Every run records video; these double as review reels of the integration
 * working end-to-end: sign in → chat redlines → proofread redlines → draft.
 *
 * Model output is non-deterministic, so assertions target the CONTRACT the
 * prompts mandate (parseable ORIGINAL/REPLACEMENT blocks → an Apply button →
 * recorded tracked changes), not exact wording.
 */
import { test, expect, type Page } from "@playwright/test";
import { installOfficeMock } from "../e2e/support/office-mock";
import type { WordCalls } from "../e2e/support/office-mock";

const EMAIL = "demo@mike.local";
const PASSWORD = "MikeDemo!2026";

// A small services agreement with deliberate typos ("Suplier", "reciept")
// and PII (name + address) so Proofread and chat redlining have real work.
const CONTRACT = [
  "SERVICES AGREEMENT",
  "",
  "This Services Agreement is entered into between Acme Consulting Ltd and John Smith of 10 Downing Street, London.",
  "",
  "1. The Suplier shall provide the consulting services described in Schedual 1 with reasonable skill and care.",
  "",
  "2. The Client shall pay all invoices within thirty (30) days of reciept.",
  "",
  "3. Either party may terminate this agreement on sixty (60) days writen notice.",
].join("\n");

async function openSignedIn(page: Page): Promise<void> {
  await page.addInitScript(installOfficeMock, {
    documentText: CONTRACT,
    selectionText: "The Suplier shall provide the consulting services",
  });
  await page.goto("/taskpane.html");
  await page.getByPlaceholder("you@firm.com").fill(EMAIL);
  await page.getByPlaceholder("••••••••").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("tab", { name: "Chat" })).toBeVisible({
    timeout: 45_000,
  });
}

async function wordCalls(page: Page): Promise<WordCalls> {
  return page.evaluate(
    () => (window as unknown as { __WORD_CALLS__: WordCalls }).__WORD_CALLS__,
  );
}

test("signs in and applies chat-proposed redlines from a real model", async ({
  page,
}) => {
  await openSignedIn(page);

  await page.getByRole("switch", { name: "Suggest tracked edits" }).click();
  await page
    .getByPlaceholder("Ask Mike…")
    .fill(
      "Fix the spelling mistakes in this agreement. Propose each fix as an edit."
    );
  await page.getByRole("button", { name: "Send" }).click();

  const applyButton = page.getByRole("button", {
    name: /Apply \d+ tracked edits?/,
  });
  await expect(applyButton).toBeVisible();
  await page.waitForTimeout(1500);
  await applyButton.click();
  await expect(page.getByText(/Applied \d+ of \d+ edits? as tracked/)).toBeVisible();

  const calls = await wordCalls(page);
  expect(calls.trackedChanges.length).toBeGreaterThan(0);
  expect(calls.changeTrackingMode).toBe("TrackAll");
  await page.waitForTimeout(2000);
});

test("proofreads the document with a real model and applies tracked corrections", async ({
  page,
}) => {
  await openSignedIn(page);

  await page.getByRole("tab", { name: "Actions" }).click();
  await page.getByRole("button", { name: "Proofread entire document" }).click();

  const applyButton = page.getByRole("button", {
    name: /Apply \d+ corrections? \(tracked\)/,
  });
  await expect(applyButton).toBeVisible();
  await page.waitForTimeout(1500);
  await applyButton.click();
  await expect(
    page.getByText(/Applied \d+ of \d+ corrections? as tracked changes\./)
  ).toBeVisible();

  const calls = await wordCalls(page);
  expect(calls.trackedChanges.length).toBeGreaterThan(0);
  expect(calls.changeTrackingMode).toBe("TrackAll");
  await page.waitForTimeout(2000);
});

test("drafts a clause with a real model and inserts it as a tracked addition", async ({
  page,
}) => {
  await openSignedIn(page);

  await page.getByRole("tab", { name: "Actions" }).click();
  await page
    .getByPlaceholder("e.g. limitation of liability for SaaS product")
    .fill("mutual confidentiality clause for a consulting agreement");
  await page.getByRole("button", { name: "Draft clause" }).click();

  const insertTracked = page.getByRole("button", {
    name: "Insert below (tracked)",
  });
  await expect(insertTracked).toBeVisible();
  await page.waitForTimeout(1500);
  await insertTracked.click();

  await expect
    .poll(async () => (await wordCalls(page)).trackedChanges.length, {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);
  const calls = await wordCalls(page);
  expect(calls.trackedChanges[0].location).toBe("After");
  expect(calls.inserts).toHaveLength(0);
  await page.waitForTimeout(2000);
});
