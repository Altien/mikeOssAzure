import { test, expect } from "./support/fixtures";
import type { Addin } from "./support/fixtures";

const TOKEN = "test-jwt";

async function gotoActions(addin: Addin): Promise<void> {
  await addin.gotoTaskpane({ token: TOKEN });
  await addin.expectAuthedShell();
  await addin.page.getByRole("button", { name: "Open menu" }).click();
  await addin.page.getByRole("menuitem", { name: "Quick Actions" }).click();
  await expect(
    addin.page.getByTestId("quick-actions-full-screen"),
  ).toBeVisible();
}

test("matches the workflows page layout and lists the initial-view actions", async ({
  addin,
  page,
}) => {
  await gotoActions(addin);

  await expect(page.getByTestId("quick-actions-page-title")).toHaveText(
    "Quick Actions",
  );
  await expect(page.getByTestId("quick-actions-page-title")).toHaveClass(
    /font-serif/,
  );
  await expect(page.getByTestId("quick-actions-page-title")).toHaveClass(
    /text-2xl/,
  );
  await expect(page.getByTestId("quick-actions-page-title")).toHaveClass(
    /font-medium/,
  );
  await expect(page.getByPlaceholder("Search quick actions...")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Proofread agreement" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Compare documents" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Extract key terms" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Draft from template" }),
  ).toBeVisible();
});

test("filters quick actions", async ({ addin, page }) => {
  await gotoActions(addin);

  await page.getByPlaceholder("Search quick actions...").fill("extract");
  await expect(
    page.getByRole("button", { name: "Extract key terms" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Proofread agreement" }),
  ).toHaveCount(0);

  await page.getByPlaceholder("Search quick actions...").fill("missing");
  await expect(page.getByText("No quick actions found.")).toBeVisible();
});

test("opens action details without leaving the Quick Actions page", async ({
  addin,
  page,
}) => {
  await gotoActions(addin);

  await page
    .getByRole("button", { name: /Proofread agreement.*Active/ })
    .click();

  const modal = page.getByRole("dialog");
  await expect(modal).toBeVisible();
  await expect(modal).toHaveAttribute("aria-label", "Proofread agreement");
  await expect(modal.getByLabel("Name")).toHaveValue("Proofread agreement");
  await expect(modal.getByLabel("Workflow used")).toContainText("Proofread");
  await expect(modal.getByLabel("Prompt")).toHaveValue(
    "Review the current document for drafting quality, internal consistency, grammar, punctuation, formatting, numbering, defined terms, and cross-reference errors. List each issue with its location, severity, and a specific recommended fix.",
  );
  await expect(modal.getByLabel("Prompt")).toHaveClass(/min-h-28/);
  await expect(modal.getByRole("button", { name: "Save" })).toBeDisabled();
  await modal.getByLabel("Name").fill("Review agreement");
  await expect(modal.getByRole("button", { name: "Save" })).toBeEnabled();
  await expect(modal.getByText("Quick Actions", { exact: true })).toBeVisible();
  await expect(modal.getByRole("switch", { name: "Active" })).toBeChecked();
  await expect(page.getByText("Active", { exact: true }).first()).toHaveClass(
    /text-green-600/,
  );
  await expect(page.getByTestId("quick-actions-full-screen")).toBeVisible();
  // The Assistant stays mounted so its draft and conversation survive
  // navigation, but it must not be visible behind the Quick Actions page.
  await expect(page.getByPlaceholder("How can I help?")).toBeHidden();
});

test("creates a named quick action from the top bar", async ({
  addin,
  page,
}) => {
  const workflow = {
    id: "wf-review-clauses",
    metadata: {
      title: "Review clauses",
      type: "assistant",
      language: "English",
      practice: null,
      jurisdictions: null,
    },
    skill_md: "Review the selected clauses.",
    is_system: false,
  };
  const created = {
    id: "qa-review-clauses",
    workflow_id: workflow.id,
    name: "Clause check",
    prompt: "Focus on liability clauses.",
    document_upload: true,
    enabled: true,
    sort_order: 4,
    workflow: { id: workflow.id, title: workflow.metadata.title },
  };
  await addin.mockApiJson("GET", "**/workflows**", [workflow]);
  await addin.mockApiJson("POST", "**/quick-actions", created, {
    status: 201,
  });
  await gotoActions(addin);

  const header = page.getByTestId("floating-header");
  await header.getByRole("button", { name: "New quick action" }).click();
  const modal = page.getByRole("dialog", { name: "New Quick Action" });
  await expect(modal).toBeVisible();
  await modal.getByLabel("Workflow used").click();
  await page
    .getByRole("menuitem", { name: "Review clauses", exact: true })
    .click();
  await expect(modal.getByLabel("Name")).toHaveValue("Review clauses");
  await modal.getByLabel("Name").fill("Clause check");
  await modal.getByLabel("Prompt").fill("Focus on liability clauses.");
  await modal.getByRole("switch", { name: "Request document upload" }).click();

  const requestPromise = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname.endsWith("/quick-actions"),
  );
  await modal.getByRole("button", { name: "Create" }).click();
  expect((await requestPromise).postDataJSON()).toEqual({
    workflow_id: workflow.id,
    name: "Clause check",
    prompt: "Focus on liability clauses.",
    document_upload: true,
    enabled: true,
    sort_order: 4,
  });
  await expect(modal).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Clause check" })).toBeVisible();
});

test("inactive actions disappear from the Assistant initial view", async ({
  addin,
  page,
}) => {
  await gotoActions(addin);

  await page
    .getByRole("button", { name: /Proofread agreement.*Active/ })
    .click();
  const modal = page.getByRole("dialog", { name: "Proofread agreement" });
  await modal.getByRole("switch", { name: "Active" }).click();
  await expect(modal.getByRole("switch", { name: "Active" })).not.toBeChecked();
  await modal.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByRole("button", { name: /Proofread agreement.*Inactive/ }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("menuitem", { name: "Assistant" }).click();
  await expect(
    page.getByRole("button", { name: "Proofread agreement" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Compare documents" }),
  ).toBeVisible();
});
