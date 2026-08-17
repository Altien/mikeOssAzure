/**
 * E2E coverage for document citations: <cite>...</cite> markers in assistant
 * prose render as clickable chips (never raw tags), and clicking one scrolls
 * Word to the quoted passage by searching and selecting it.
 */
import { test, expect } from "./support/fixtures";

const TOKEN = "test-jwt-token";
const DOCUMENT_TEXT =
  "TERMINATION. Either party may terminate this Agreement on sixty (60) days written notice to the other party.";

test.beforeEach(async ({ addin }) => {
  addin.seedToken(TOKEN);
});

test("renders a citation chip and clicking it selects the quoted text in Word", async ({
  addin,
  page,
}) => {
  // Split mid-tag to prove streaming never flashes raw <cite> markup.
  await addin.mockChatStream([
    "The contract can be ended early: it allows termination on <ci",
    "te>sixty (60) days written notice</cite> by either party.",
  ]);
  await addin.gotoTaskpane({ documentText: DOCUMENT_TEXT });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Can we exit early?");
  await page.getByRole("button", { name: "Send" }).click();

  const chip = page.getByRole("link", {
    name: "sixty (60) days written notice",
  });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("title", "Show in the document");
  await expect(page.locator("body")).not.toContainText("<cite>");
  await expect(page.locator("body")).not.toContainText("</cite>");

  const searchesBefore = (await addin.wordCalls()).searches;
  await chip.click();
  await expect
    .poll(async () => (await addin.wordCalls()).revealedChanges)
    .toEqual([
      {
        text: "sixty (60) days written notice",
        location: "Select",
        original: "sixty (60) days written notice",
      },
    ]);
  expect((await addin.wordCalls()).searches).toBeGreaterThan(searchesBefore);
});

test("a citation whose text is no longer in the document searches but never selects", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([
    "See <cite>the indemnification cap of two million dollars</cite> for details.",
  ]);
  await addin.gotoTaskpane({ documentText: DOCUMENT_TEXT });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("What is the cap?");
  await page.getByRole("button", { name: "Send" }).click();

  const chip = page.getByRole("link", {
    name: "the indemnification cap of two million dollars",
  });
  await expect(chip).toBeVisible();
  const searchesBefore = (await addin.wordCalls()).searches;
  await chip.click();

  // Exact then case-insensitive search both miss; nothing is selected and
  // the pane stays healthy.
  await expect
    .poll(async () => (await addin.wordCalls()).searches)
    .toBeGreaterThanOrEqual(searchesBefore + 2);
  expect((await addin.wordCalls()).revealedChanges).toEqual([]);
  await expect(chip).toBeVisible();
});

test("the backend's native [n] markers become chips resolved through the citations array", async ({
  addin,
  page,
}) => {
  // The shared chat pipeline emits plain "[1]" in prose plus a citations
  // frame carrying the verbatim quote — the pane must join the two.
  await addin.mockChatStream(
    ["The notice period is 60 days [1]. It binds both parties [2]."],
    {
      citations: [
        { marker: "[1]", quote: "sixty (60) days written notice" },
        { marker: "[2]", quote: "not text that exists in this document" },
      ],
    },
  );
  await addin.gotoTaskpane({ documentText: DOCUMENT_TEXT });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Notice period?");
  await page.getByRole("button", { name: "Send" }).click();

  const chipOne = page.getByRole("link", { name: "[1]", exact: true });
  await expect(chipOne).toBeVisible();
  await expect(
    page.getByRole("link", { name: "[2]", exact: true }),
  ).toBeVisible();

  await chipOne.click();
  await expect
    .poll(async () => (await addin.wordCalls()).revealedChanges)
    .toEqual([
      {
        text: "sixty (60) days written notice",
        location: "Select",
        original: "sixty (60) days written notice",
      },
    ]);
});

test("citation matching falls back to a case-insensitive search", async ({
  addin,
  page,
}) => {
  // The model quotes with different casing than the document.
  await addin.mockChatStream([
    "Notice period: <cite>SIXTY (60) DAYS WRITTEN NOTICE</cite>.",
  ]);
  await addin.gotoTaskpane({ documentText: DOCUMENT_TEXT });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Notice period?");
  await page.getByRole("button", { name: "Send" }).click();

  await page
    .getByRole("link", { name: "SIXTY (60) DAYS WRITTEN NOTICE" })
    .click();
  await expect
    .poll(async () => (await addin.wordCalls()).revealedChanges.length)
    .toBe(1);
});
