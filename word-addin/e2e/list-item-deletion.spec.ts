/**
 * E2E coverage for numbering-aware paragraph deletion.
 *
 * A delete-only edit that quotes a paragraph's ENTIRE text removes the
 * paragraph itself — paragraph mark included — instead of leaving an empty
 * list item behind. Word then renumbers the surviving items, which these
 * tests observe through the markdown document context sent with the next
 * message (the real renderBodyAsMarkdown path, not a bespoke hook).
 *
 * Every "escalates" test fails on the text-range-only delete (the mock
 * records "Delete" instead of "DeleteParagraph" and the emptied item keeps
 * its number) and passes with the whole-paragraph escalation.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./support/fixtures";
import type { Addin } from "./support/fixtures";

const TOKEN = "test-jwt-token";

const NUMBERED_DOC = {
  documentText: "Steps\nFoo goes first.\nBar goes second.\nBaz goes third.",
  documentBlocks: [
    { text: "Steps", styleBuiltIn: "Heading1" },
    { text: "Foo goes first.", listString: "1.", listLevel: 0 },
    { text: "Bar goes second.", listString: "2.", listLevel: 0 },
    { text: "Baz goes third.", listString: "3.", listLevel: 0 },
  ],
};

const DELETE_ITEM_TWO = [
  "Removing point 2.\n\n",
  "<original>Bar goes second.</original>\n<replacement></replacement>\n<reason>Requested removal.</reason>",
];

test.beforeEach(async ({ addin }) => {
  addin.seedToken(TOKEN);
});

/** Send a follow-up message and return the document_context it carried. */
async function nextDocumentContext(
  addin: Addin,
  page: Page,
): Promise<string> {
  await addin.mockChatStream(["ok"]);
  await page.getByPlaceholder("How can I help?").fill("Thanks");
  const requestPromise = page.waitForRequest("**/word-chat");
  await page.getByRole("button", { name: "Send" }).click();
  const body = (await requestPromise).postDataJSON();
  return String(body.document_context ?? "");
}

async function chooseApplyMode(
  page: Page,
  mode: "Review" | "Edit",
): Promise<void> {
  await page.getByTestId("edit-apply-toggle").click();
  await page.getByRole("menuitem", { name: new RegExp(mode) }).click();
  await expect(page.getByTestId("edit-apply-toggle")).toHaveText(
    new RegExp(mode),
  );
}

test("review mode: accepting a full-item deletion removes the paragraph and renumbers", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream(DELETE_ITEM_TWO);
  await addin.gotoTaskpane(NUMBERED_DOC);
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Remove point 2");
  await page.getByRole("button", { name: "Send" }).click();

  // The whole paragraph is deleted, not just the matched text run.
  await expect
    .poll(async () => (await addin.wordCalls()).trackedChanges)
    .toEqual([
      { text: "", location: "DeleteParagraph", original: "Bar goes second." },
    ]);
  const accept = page.getByRole("button", { name: "Accept", exact: true });
  await expect(accept).toHaveCount(1);
  await accept.click();
  await expect(page.getByText("Accepted.", { exact: true })).toBeVisible();

  // The item is gone and Word's numbering closed the gap — no empty "2.".
  const context = await nextDocumentContext(addin, page);
  expect(context).toContain("1. Foo goes first.");
  expect(context).toContain("2. Baz goes third.");
  expect(context).not.toContain("Bar goes second.");
  expect(context).not.toContain("3.");
});

test("direct mode: the item is removed and renumbered with no review step", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream(DELETE_ITEM_TWO);
  await addin.gotoTaskpane(NUMBERED_DOC);
  await addin.expectAuthedShell();

  await chooseApplyMode(page, "Edit");
  await page.getByPlaceholder("How can I help?").fill("Remove point 2");
  await page.getByRole("button", { name: "Send" }).click();

  await expect
    .poll(async () => (await addin.wordCalls()).acceptedChanges)
    .toEqual([
      { text: "", location: "DeleteParagraph", original: "Bar goes second." },
    ]);
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toHaveCount(0);

  const context = await nextDocumentContext(addin, page);
  expect(context).toContain("1. Foo goes first.");
  expect(context).toContain("2. Baz goes third.");
  expect(context).not.toContain("Bar goes second.");
});

test("rejecting the deletion restores the item with its original number", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream(DELETE_ITEM_TWO);
  await addin.gotoTaskpane(NUMBERED_DOC);
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Remove point 2");
  await page.getByRole("button", { name: "Send" }).click();

  const reject = page.getByRole("button", { name: "Reject", exact: true });
  await expect(reject).toHaveCount(1);
  await reject.click();
  await expect(page.getByText("Rejected.", { exact: true })).toBeVisible();

  const context = await nextDocumentContext(addin, page);
  expect(context).toContain("1. Foo goes first.");
  expect(context).toContain("2. Bar goes second.");
  expect(context).toContain("3. Baz goes third.");
});

test("a partial deletion inside an item never escalates to the paragraph", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([
    "Trimming.\n\n",
    "<original>and wanders on.</original>\n<replacement></replacement>\n<reason>Tighter.</reason>",
  ]);
  await addin.gotoTaskpane({
    documentText: "Foo goes first.\nBar goes second and wanders on.",
    documentBlocks: [
      { text: "Foo goes first.", listString: "1.", listLevel: 0 },
      { text: "Bar goes second and wanders on.", listString: "2.", listLevel: 0 },
    ],
  });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Trim point 2");
  await page.getByRole("button", { name: "Send" }).click();

  // The safety property: only a whole-paragraph quote may remove a
  // paragraph. A deletion of part of the item stays a text-range delete.
  await expect
    .poll(async () => (await addin.wordCalls()).trackedChanges)
    .toEqual([{ text: "", location: "Delete", original: "and wanders on." }]);
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByText("Accepted.", { exact: true })).toBeVisible();

  const context = await nextDocumentContext(addin, page);
  expect(context).toContain("2. Bar");
});

test("an original quoting the renderer's list marker still deletes the paragraph", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([
    "Removing point 2.\n\n",
    "<original>2. Bar goes second.</original>\n<replacement></replacement>\n<reason>Requested removal.</reason>",
  ]);
  await addin.gotoTaskpane(NUMBERED_DOC);
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Remove point 2");
  await page.getByRole("button", { name: "Send" }).click();

  // "2. " is a renderer annotation. The stripped-marker retry adopts the
  // bare text FIRST, so the whole-paragraph equality check still fires.
  await expect
    .poll(async () => (await addin.wordCalls()).trackedChanges)
    .toEqual([
      { text: "", location: "DeleteParagraph", original: "Bar goes second." },
    ]);
});

test("an over-length item degrades to an honest skip, not a partial delete", async ({
  addin,
  page,
}) => {
  const longItem = `This clause ${"reiterates its own point at considerable length ".repeat(6)}and then finally ends.`;
  expect(longItem.length).toBeGreaterThan(255);
  await addin.mockChatStream([
    "Removing the long clause.\n\n",
    `<original>${longItem}</original>\n<replacement></replacement>\n<reason>Requested removal.</reason>`,
  ]);
  await addin.gotoTaskpane({
    documentText: `Foo goes first.\n${longItem}`,
    documentBlocks: [
      { text: "Foo goes first.", listString: "1.", listLevel: 0 },
      { text: longItem, listString: "2.", listLevel: 0 },
    ],
  });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Remove point 2");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(
    page.getByText(
      "Skipped — this passage is too long for Word’s search or spans paragraphs.",
    ),
  ).toBeVisible();
  expect((await addin.wordCalls()).trackedChanges).toEqual([]);
});

test("a whole plain paragraph deletes too, leaving no empty line", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([
    "Removing the aside.\n\n",
    "<original>This aside adds nothing.</original>\n<replacement></replacement>\n<reason>Redundant.</reason>",
  ]);
  await addin.gotoTaskpane({
    documentText:
      "The agreement begins.\nThis aside adds nothing.\nThe agreement continues.",
    documentBlocks: [
      { text: "The agreement begins." },
      { text: "This aside adds nothing." },
      { text: "The agreement continues." },
    ],
  });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Remove the aside");
  await page.getByRole("button", { name: "Send" }).click();

  await expect
    .poll(async () => (await addin.wordCalls()).trackedChanges)
    .toEqual([
      {
        text: "",
        location: "DeleteParagraph",
        original: "This aside adds nothing.",
      },
    ]);
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByText("Accepted.", { exact: true })).toBeVisible();

  const context = await nextDocumentContext(addin, page);
  expect(context).toContain("The agreement begins.\nThe agreement continues.");
});
