/**
 * E2E coverage for the conflicted card's "Accept & apply" action.
 *
 * Mike never layers a tracked replacement over pending revisions — the card
 * skips as conflicted instead. "Accept & apply" is the explicit two-step
 * escape hatch: accept the revisions occupying the target passage, then
 * rerun the edit's normal apply lifecycle, so the resulting card's
 * Accept/Reject still resolves exactly the revisions it created.
 */
import { test, expect } from "./support/fixtures";
import { replacementEdit, wordEdits } from "./support/editProtocol";
import type { Page } from "@playwright/test";

const TOKEN = "test-jwt-token";

test.beforeEach(async ({ addin }) => {
  addin.seedToken(TOKEN);
});

async function pauseNextWordRun(page: Page): Promise<() => Promise<void>> {
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      Word: typeof Word;
      __RELEASE_NEXT_WORD_RUN__?: () => void;
    };
    const originalRun = testWindow.Word.run.bind(testWindow.Word);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    testWindow.Word.run = (async (...args: Parameters<typeof Word.run>) => {
      testWindow.Word.run = originalRun;
      await gate;
      return originalRun(...args);
    }) as typeof Word.run;
    testWindow.__RELEASE_NEXT_WORD_RUN__ = release;
  });
  return () =>
    page.evaluate(() => {
      const testWindow = window as typeof window & {
        __RELEASE_NEXT_WORD_RUN__?: () => void;
      };
      testWindow.__RELEASE_NEXT_WORD_RUN__?.();
      delete testWindow.__RELEASE_NEXT_WORD_RUN__;
    });
}

test("Accept & apply supersedes the occupying revisions and lands the edit", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([
    "One change.\n\n",
    wordEdits(replacementEdit("The Suplier", "The Supplier", "Typo.")),
  ]);
  await addin.gotoTaskpane({
    documentText: "The Suplier shall deliver the goods.",
    existingTrackedChangeOriginals: ["The Suplier"],
  });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Fix the typo");
  await page.getByRole("button", { name: "Send" }).click();

  // The target passage carries a pending revision → conflicted card with
  // the retry action, and nothing has been written to the document.
  const retryButton = page.getByRole("button", { name: "Accept & apply" });
  await retryButton.waitFor();
  await expect(retryButton).toHaveClass(/bg-blue-600/);
  const viewButton = page.getByRole("button", { name: "View", exact: true });
  await expect(viewButton).toBeVisible();
  const [retryBounds, viewBounds] = await Promise.all([
    retryButton.boundingBox(),
    viewButton.boundingBox(),
  ]);
  expect(retryBounds).not.toBeNull();
  expect(viewBounds).not.toBeNull();
  expect(retryBounds!.x).toBeLessThan(viewBounds!.x);
  expect((await addin.wordCalls()).trackedChanges).toEqual([]);
  expect((await addin.wordCalls()).acceptedChanges).toEqual([]);

  await viewButton.click();
  await expect
    .poll(async () => (await addin.wordCalls()).revealedChanges)
    .toEqual([
      { text: "The Suplier", location: "Select", original: "The Suplier" },
    ]);
  await expect(retryButton).toBeVisible();

  const releaseAcceptAndApply = await pauseNextWordRun(page);
  await retryButton.click();
  await expect(
    page.getByRole("button", { name: "Accepting & applying..." }),
  ).toBeDisabled();
  await releaseAcceptAndApply();

  // Step 1: the occupying revision was accepted (and only it)…
  await expect
    .poll(async () => (await addin.wordCalls()).acceptedChanges)
    .toEqual([
      { text: "The Suplier", location: "Existing", original: "The Suplier" },
    ]);
  // …step 2: the edit then applied as a fresh pending redline with the
  // normal review controls.
  await expect
    .poll(async () => (await addin.wordCalls()).trackedChanges.length)
    .toBe(1);
  const acceptButton = page.getByRole("button", {
    name: "Accept",
    exact: true,
  });
  await expect(acceptButton).toHaveCount(1);

  // The new card's Accept resolves exactly the revision it created.
  const releaseAccept = await pauseNextWordRun(page);
  await acceptButton.click();
  await expect(
    page.getByRole("button", { name: "Accepting..." }),
  ).toBeDisabled();
  await releaseAccept();
  await expect(page.getByText("Accepted.", { exact: true })).toBeVisible();
  expect(
    (await addin.wordCalls()).acceptedChanges.filter(
      (change) => change.location !== "Existing",
    ),
  ).toEqual([
    { text: "The Supplier", location: "After", original: "The Suplier" },
  ]);
});
