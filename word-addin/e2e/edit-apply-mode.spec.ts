/**
 * E2E coverage for the edit apply-mode toggle: a "Review" switch in the
 * composer, on by default. On keeps the approval flow — streamed edits land
 * as pending tracked changes resolved from their cards — while off applies
 * each streamed edit and accepts it immediately, so the document shows final
 * text with no review step.
 */
import { test, expect } from "./support/fixtures";

const TOKEN = "test-jwt-token";

const REDLINE_CHUNKS = [
  "Two issues found.\n\n",
  "<original>The Suplier</original>\n<replacement>The Supplier</replacement>\n<reason>Typo.</reason>\n\n",
  "<original>shall deliver goods</original>\n<replacement>shall deliver the goods</replacement>\n<reason>Missing article.</reason>",
];
const DOCUMENT_TEXT = "The Suplier shall deliver goods to the Buyer.";

test.beforeEach(async ({ addin }) => {
  addin.seedToken(TOKEN);
});

test("shows the Review switch in the composer, on by default", async ({
  addin,
  page,
}) => {
  await addin.gotoTaskpane();
  await addin.expectAuthedShell();

  // The toggle lives inside the chat input, next to the composer accessories:
  // a single "Review" label with an on/off switch. On = approval flow,
  // off = edits apply directly.
  const composer = page.getByTestId("chat-input");
  const review = composer.getByRole("switch", { name: "Review" });
  await expect(review).toBeVisible();
  await expect(review).toHaveAttribute("aria-checked", "true");
  // And nothing renders in the floating header any more.
  await expect(
    page.getByTestId("floating-header").getByTestId("edit-apply-toggle"),
  ).toHaveCount(0);
});

test("direct mode applies streamed edits to the document and accepts them immediately", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream(REDLINE_CHUNKS, {
    chatId: "11111111-1111-4111-8111-111111111111",
    assistantMessageId: "22222222-2222-4222-8222-222222222222",
  });
  await addin.gotoTaskpane({ documentText: DOCUMENT_TEXT });
  await addin.expectAuthedShell();

  await page.getByRole("switch", { name: "Review" }).click();
  await page.getByPlaceholder("How can I help?").fill("Fix the contract");
  await page.getByRole("button", { name: "Send" }).click();

  // Both edits are written as tracked changes and then accepted without any
  // user interaction.
  await expect
    .poll(async () => (await addin.wordCalls()).acceptedChanges)
    .toEqual([
      { text: "The Supplier", location: "After", original: "The Suplier" },
      {
        text: "shall deliver the goods",
        location: "After",
        original: "shall deliver goods",
      },
    ]);
  await expect(page.getByText("Applied to the document.")).toHaveCount(2);

  // No review controls: the cards are informational in direct mode.
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Reject", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Accept all" })).toHaveCount(
    0,
  );

  // Accepting released the revisions, so nothing pending stays anchored in
  // the document.
  const documentSnapshot = await addin.wordDocument();
  expect(
    documentSnapshot.bookmarks.filter(
      (bookmark) => bookmark.pendingRevisionCount > 0,
    ),
  ).toEqual([]);
});

test("review mode still routes streamed edits through pending cards", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream(REDLINE_CHUNKS);
  await addin.gotoTaskpane({ documentText: DOCUMENT_TEXT });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Fix the contract");
  await page.getByRole("button", { name: "Send" }).click();

  await expect
    .poll(async () => (await addin.wordCalls()).trackedChanges.length)
    .toBe(2);
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toHaveCount(2);
  expect((await addin.wordCalls()).acceptedChanges).toEqual([]);

  await page
    .getByRole("button", { name: "Accept", exact: true })
    .first()
    .click();
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

  const review = page.getByRole("switch", { name: "Review" });
  await review.click();
  await expect(review).toHaveAttribute("aria-checked", "false");

  await addin.reloadTaskpane();
  await addin.expectAuthedShell();
  await expect(page.getByRole("switch", { name: "Review" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
});

test("a mid-stream toggle only affects edits that have not been applied yet", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream(REDLINE_CHUNKS);
  await addin.gotoTaskpane({ documentText: DOCUMENT_TEXT });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Fix the contract");
  await page.getByRole("button", { name: "Send" }).click();
  // The mock stream arrives as one response body, so both edits apply under
  // whichever mode was active at send time — this guards state bleed rather
  // than true interleaving.
  await expect
    .poll(async () => (await addin.wordCalls()).trackedChanges.length)
    .toBe(2);
  await page.getByRole("switch", { name: "Review" }).click();

  // Already-applied edits keep their pending review cards.
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toHaveCount(2);
  expect((await addin.wordCalls()).acceptedChanges).toEqual([]);
});
