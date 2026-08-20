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

const TOKEN = "test-jwt-token";

test.beforeEach(async ({ addin }) => {
  addin.seedToken(TOKEN);
});

test("Accept & apply supersedes the occupying revisions and lands the edit", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([
    "One change.\n\n",
    "<original>The Suplier</original>\n<replacement>The Supplier</replacement>\n<reason>Typo.</reason>",
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
  expect((await addin.wordCalls()).trackedChanges).toEqual([]);
  expect((await addin.wordCalls()).acceptedChanges).toEqual([]);

  await retryButton.click();

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
  const acceptButton = page.getByRole("button", { name: "Accept", exact: true });
  await expect(acceptButton).toHaveCount(1);

  // The new card's Accept resolves exactly the revision it created.
  await acceptButton.click();
  await expect(page.getByText("Accepted.", { exact: true })).toBeVisible();
  expect(
    (await addin.wordCalls()).acceptedChanges.filter(
      (change) => change.location !== "Existing",
    ),
  ).toEqual([
    { text: "The Supplier", location: "After", original: "The Suplier" },
  ]);
});
