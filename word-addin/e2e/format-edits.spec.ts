/**
 * E2E coverage for format-only tracked changes: <original>/<format>/<reason>
 * blocks restyle existing text (bold/italic/underline) under TrackAll instead
 * of replacing it, and their cards resolve the resulting "Formatted" revision
 * exactly like text edits.
 */
import { test, expect } from "./support/fixtures";

const TOKEN = "test-jwt-token";
const DOCUMENT_TEXT =
  "GOVERNING LAW. This Agreement is governed by the laws of Singapore.";

test.beforeEach(async ({ addin }) => {
  addin.seedToken(TOKEN);
});

test("streams a format block into Word as a formatted tracked change and resolves it from the card", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([
    "One heading needs emphasis.\n\n",
    "<original>GOVERNING LAW.</original>\n<format>bold</format>\n<reason>Emphasize the section heading.</reason>",
  ]);
  await addin.gotoTaskpane({ documentText: DOCUMENT_TEXT });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Bold the heading");
  await page.getByRole("button", { name: "Send" }).click();

  // The formatting write happened under TrackAll and no text was replaced.
  await expect
    .poll(async () => (await addin.wordCalls()).trackedChanges)
    .toEqual([
      {
        text: "GOVERNING LAW.",
        location: "Format:bold",
        original: "GOVERNING LAW.",
      },
    ]);
  expect((await addin.wordCalls()).inserts).toEqual([]);

  // The card previews the styling on the original text (no red/green diff)
  // and stays fully review-linked.
  const card = page.locator("[data-edit-status='pending']");
  await expect(card).toHaveCount(1);
  await expect(card.locator("span.font-bold")).toHaveText("GOVERNING LAW.");
  await expect(card).toContainText("bold");
  await expect(card.locator("span.line-through")).toHaveCount(0);

  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByText("Accepted.", { exact: true })).toBeVisible();
  expect((await addin.wordCalls()).acceptedChanges).toEqual([
    {
      text: "GOVERNING LAW.",
      location: "Format:bold",
      original: "GOVERNING LAW.",
    },
  ]);
});

test("rejecting a format edit leaves the passage's styling decision to Word", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([
    "<original>GOVERNING LAW.</original>\n<format>italic, underline</format>\n<reason>Style the heading.</reason>",
  ]);
  await addin.gotoTaskpane({ documentText: DOCUMENT_TEXT });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Style the heading");
  await page.getByRole("button", { name: "Send" }).click();

  // Both font properties were written; the mock coalesces them into one
  // Formatted revision, mirroring Word's per-run coalescing.
  await expect
    .poll(async () => (await addin.wordCalls()).trackedChanges.length)
    .toBe(2);
  const card = page.locator("[data-edit-status='pending']");
  await expect(card.locator("span.italic.underline")).toHaveText(
    "GOVERNING LAW.",
  );
  await expect(card).toContainText("italic, underline");

  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.getByText("Rejected.", { exact: true })).toBeVisible();
  expect((await addin.wordCalls()).rejectedChanges).toHaveLength(1);
  expect((await addin.wordCalls()).acceptedChanges).toEqual([]);
});

test("direct mode applies a format edit as final formatting with no pending revision", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([
    "<original>GOVERNING LAW.</original>\n<format>bold</format>\n<reason>Emphasize the heading.</reason>",
  ]);
  await addin.gotoTaskpane({ documentText: DOCUMENT_TEXT });
  await addin.expectAuthedShell();

  await page.getByRole("switch", { name: "Review" }).click();
  await page.getByPlaceholder("How can I help?").fill("Bold the heading");
  await page.getByRole("button", { name: "Send" }).click();

  await expect
    .poll(async () => (await addin.wordCalls()).acceptedChanges)
    .toEqual([
      {
        text: "GOVERNING LAW.",
        location: "Format:bold",
        original: "GOVERNING LAW.",
      },
    ]);
  await expect(page.getByText("Applied to the document.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toHaveCount(0);
});

test("a heading format applies the paragraph style as a reviewable tracked change", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([
    "<original>GOVERNING LAW.</original>\n<format>heading 1</format>\n<reason>Make the section title a proper heading.</reason>",
  ]);
  await addin.gotoTaskpane({ documentText: DOCUMENT_TEXT });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Make it a heading");
  await page.getByRole("button", { name: "Send" }).click();

  // The style write is recorded against the paragraph, tracked like any
  // other formatting revision — and "heading 1" normalizes to heading1.
  await expect
    .poll(async () => (await addin.wordCalls()).trackedChanges)
    .toEqual([
      {
        text: "GOVERNING LAW.",
        location: "Format:style:Heading1",
        original: "GOVERNING LAW.",
      },
    ]);
  const card = page.locator("[data-edit-status='pending']");
  await expect(card).toContainText("heading 1");

  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByText("Accepted.", { exact: true })).toBeVisible();
  expect((await addin.wordCalls()).acceptedChanges).toEqual([
    {
      text: "GOVERNING LAW.",
      location: "Format:style:Heading1",
      original: "GOVERNING LAW.",
    },
  ]);
});

test("a format block naming no recognized formatting settles as incomplete and never touches Word", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([
    "<original>GOVERNING LAW.</original>\n<format>sparkly</format>\n<reason>Not a real format.</reason>",
  ]);
  await addin.gotoTaskpane({ documentText: DOCUMENT_TEXT });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Style the heading");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(
    page.getByText("Incomplete change — not applied."),
  ).toBeVisible();
  const calls = await addin.wordCalls();
  expect(calls.trackedChanges).toEqual([]);
  expect(calls.inserts).toEqual([]);
});
