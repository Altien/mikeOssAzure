/**
 * E2E coverage for the markdown document context.
 *
 * The pane sends the active document to Mike as structure-annotated
 * markdown — heading paragraphs carry # marks, list items their markers,
 * tables render as pipe tables — while every passage's own text stays
 * byte-identical to what Word.search can locate (edit blocks and citations
 * quote it verbatim). When a model quotes a renderer marker anyway, the
 * apply and citation paths retry the search with the markers stripped.
 *
 * Every test here fails on the flat body.text implementation and passes
 * with the markdown renderer + stripped-marker fallback.
 */
import { test, expect } from "./support/fixtures";
import { replacementEdit, wordEdits } from "./support/editProtocol";

const TOKEN = "test-jwt-token";

test.beforeEach(async ({ addin }) => {
  addin.seedToken(TOKEN);
});

test("document_context carries heading, list, and table structure", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream(["ok"]);
  await addin.gotoTaskpane({
    documentText:
      "Definitions\nTerms have the meanings below.\nAffiliate means a controlled entity.",
    documentBlocks: [
      { text: "Definitions", styleBuiltIn: "Heading1" },
      { text: "Terms have the meanings below." },
      {
        text: "Affiliate means a controlled entity.",
        listString: "a.",
        listLevel: 0,
      },
      {
        tableValues: [
          ["Term", "Meaning"],
          ["Fee", "See Exhibit B"],
        ],
      },
    ],
  });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Summarize this");
  const requestPromise = page.waitForRequest("**/word-chat");
  await page.getByRole("button", { name: "Send" }).click();
  const body = (await requestPromise).postDataJSON();

  expect(body.document_context).toContain("# Definitions");
  expect(body.document_context).toContain("Terms have the meanings below.");
  expect(body.document_context).toContain(
    "a. Affiliate means a controlled entity.",
  );
  expect(body.document_context).toContain("| Term | Meaning |");
  expect(body.document_context).toContain("| --- | --- |");
  expect(body.document_context).toContain("| Fee | See Exhibit B |");
});

test("an edit quoting the renderer's heading marker still applies as a tracked change", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([
    "One change.\n\n",
    wordEdits(
      replacementEdit("# Definitions", "Defined Terms", "Clearer heading."),
    ),
  ]);
  await addin.gotoTaskpane({
    documentText: "Definitions\nTerms have the meanings below.",
  });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Rename the heading");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();

  // "# Definitions" exists nowhere in the document — the leading "# " is
  // the context renderer's heading marker. The verbatim search misses; the
  // stripped-marker retry locates "Definitions" and redlines it there.
  await expect
    .poll(async () => (await addin.wordCalls()).trackedChanges.length)
    .toBe(1);
  expect((await addin.wordCalls()).trackedChanges[0]?.original).toBe(
    "Definitions",
  );
  await expect(
    page.getByRole("button", { name: "Accept", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByText("Skipped — source text was not found."),
  ).toHaveCount(0);
});

test("a citation quoting a list marker still selects the underlying text", async ({
  addin,
  page,
}) => {
  await addin.mockChatStream([
    "The definition is <cite>a. Affiliate means a controlled entity.</cite> in the list.",
  ]);
  await addin.gotoTaskpane({
    documentText: "Affiliate means a controlled entity.",
  });
  await addin.expectAuthedShell();

  await page.getByPlaceholder("How can I help?").fill("Define Affiliate");
  await page.getByRole("button", { name: "Send" }).click();

  const chip = page.getByRole("link", {
    name: "a. Affiliate means a controlled entity.",
  });
  await expect(chip).toBeVisible();
  await chip.click();

  // The "a. " list label is a renderer annotation; the document text has no
  // such prefix. The stripped retry finds and selects the real passage.
  await expect
    .poll(async () => (await addin.wordCalls()).revealedChanges)
    .toEqual([
      {
        text: "Affiliate means a controlled entity.",
        location: "Select",
        original: "Affiliate means a controlled entity.",
      },
    ]);
});
