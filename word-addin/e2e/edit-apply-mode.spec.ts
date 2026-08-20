/**
 * E2E coverage for the edit apply-mode control: a dropdown pill in the
 * composer showing the active mode (Review by default). Review validates each
 * streamed proposal before the user applies it; Edit applies each proposal
 * immediately as a pending tracked change. Both modes leave applied revisions
 * available for explicit acceptance or rejection.
 */
import { test, expect } from "./support/fixtures";
import { replacementEdit, wordEdits } from "./support/editProtocol";

const TOKEN = "test-jwt-token";

const REDLINE_CHUNKS = [
  "Two issues found.\n\n",
  wordEdits(
    replacementEdit("The Suplier", "The Supplier", "Typo."),
    replacementEdit(
      "shall deliver goods",
      "shall deliver the goods",
      "Missing article.",
    ),
  ),
];
const DOCUMENT_TEXT = "The Suplier shall deliver goods to the Buyer.";

test.beforeEach(async ({ addin }) => {
  addin.seedToken(TOKEN);
});

test("shows the Review mode pill in the composer, selected by default", async ({
  addin,
  page,
}) => {
  await addin.gotoTaskpane();
  await addin.expectAuthedShell();

  // The control lives inside the chat input, next to the composer
  // accessories: a pill naming the active mode that opens a two-option menu
  // with a description per mode and a check on the active one.
  const composer = page.getByTestId("chat-input");
  const pill = composer.getByTestId("edit-apply-toggle");
  await expect(pill).toBeVisible();
  await expect(pill).toHaveText(/Review/);

  await pill.click();
  const review = page.getByRole("menuitem", { name: /Review/ });
  const direct = page.getByRole("menuitem", { name: /Edit/ });
  await expect(review).toHaveAttribute("data-selected", "true");
  await expect(direct).not.toHaveAttribute("data-selected", "true");
  await expect(direct).toContainText(
    "Apply streamed edits immediately as tracked changes",
  );
  await page.keyboard.press("Escape");

  // And nothing renders in the floating header any more.
  await expect(
    page.getByTestId("floating-header").getByTestId("edit-apply-toggle"),
  ).toHaveCount(0);
});

async function chooseApplyMode(
  page: import("@playwright/test").Page,
  mode: "Review" | "Edit",
): Promise<void> {
  await page.getByTestId("edit-apply-toggle").click();
  await page.getByRole("menuitem", { name: new RegExp(mode) }).click();
  await expect(page.getByTestId("edit-apply-toggle")).toHaveText(
    new RegExp(mode),
  );
}

test("Edit mode applies streamed edits immediately as pending tracked changes", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream(REDLINE_CHUNKS, {
    chatId: "11111111-1111-4111-8111-111111111111",
    assistantMessageId: "22222222-2222-4222-8222-222222222222",
  });
  await addin.gotoTaskpane({ documentText: DOCUMENT_TEXT });
  await addin.expectAuthedShell();

  await chooseApplyMode(page, "Edit");
  await page.getByPlaceholder("How can I help?").fill("Fix the contract");
  await page.getByRole("button", { name: "Send" }).click();

  // Both edits are written immediately, but remain pending for the user.
  await expect
    .poll(async () => (await addin.wordCalls()).trackedChanges.length)
    .toBe(2);
  expect((await addin.wordCalls()).acceptedChanges).toEqual([]);
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Reject", exact: true }),
  ).toHaveCount(2);

  // The document retains both pending revision groups.
  const documentSnapshot = await addin.wordDocument();
  expect(
    documentSnapshot.bookmarks.filter(
      (bookmark) => bookmark.pendingRevisionCount > 0,
    ),
  ).toHaveLength(2);
});

test("Review mode waits for Apply before writing a tracked change", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream(REDLINE_CHUNKS);
  await addin.gotoTaskpane({ documentText: DOCUMENT_TEXT });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Fix the contract");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(
    page.getByRole("button", { name: "Apply", exact: true }),
  ).toHaveCount(2);
  expect((await addin.wordCalls()).trackedChanges).toEqual([]);
  await expect(
    page.getByRole("button", { name: "View", exact: true }),
  ).toHaveCount(2);
  expect((await addin.wordCalls()).acceptedChanges).toEqual([]);

  await page.getByRole("button", { name: "View", exact: true }).first().click();
  await expect
    .poll(async () => (await addin.wordCalls()).revealedChanges)
    .toEqual([
      { text: "The Suplier", location: "Select", original: "The Suplier" },
    ]);

  await page
    .getByRole("button", { name: "Apply", exact: true })
    .first()
    .click();
  await expect
    .poll(async () => (await addin.wordCalls()).trackedChanges.length)
    .toBe(1);
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Reject", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Apply", exact: true }),
  ).toHaveCount(1);

  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByText("Accepted.", { exact: true })).toBeVisible();
  expect((await addin.wordCalls()).acceptedChanges).toEqual([
    { text: "The Supplier", location: "After", original: "The Suplier" },
  ]);
});

test("the chosen apply mode survives a task-pane reload", async ({
  addin,
  page,
}) => {
  await addin.gotoTaskpane();
  await addin.expectAuthedShell();

  await chooseApplyMode(page, "Edit");

  await addin.reloadTaskpane();
  await addin.expectAuthedShell();
  await expect(page.getByTestId("edit-apply-toggle")).toHaveText(/Edit/);
});

test("changing mode does not auto-apply proposals already prepared for review", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream(REDLINE_CHUNKS);
  await addin.gotoTaskpane({ documentText: DOCUMENT_TEXT });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Fix the contract");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(
    page.getByRole("button", { name: "Apply", exact: true }),
  ).toHaveCount(2);
  await chooseApplyMode(page, "Edit");

  // Already-prepared cards keep their approval-before-application lifecycle.
  await expect(
    page.getByRole("button", { name: "Apply", exact: true }),
  ).toHaveCount(2);
  expect((await addin.wordCalls()).trackedChanges).toEqual([]);
  expect((await addin.wordCalls()).acceptedChanges).toEqual([]);
});
