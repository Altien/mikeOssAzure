import { expect, test, type Page } from "@playwright/test";

const playbook = {
  id: "playbook-1", userId: "e2e-user", name: "Customer MSA Playbook",
  description: "Customer-side commercial positions", status: "published",
  publishedVersionId: "version-1", publishedVersionNumber: 1,
  publishedName: "Customer MSA Playbook",
  sourceFilename: "Customer MSA Playbook.docx", importModel: "legal-committee",
  createdAt: "2026-07-30T10:00:00.000Z", updatedAt: "2026-07-30T10:00:00.000Z",
  draft: {
    name: "Customer MSA Playbook", description: "Customer-side commercial positions",
    globalGuidance: "Protect the customer while preserving commercially reasonable fallbacks.",
    representedParty: "Customer", documentTypes: ["MSA"], jurisdictions: ["New York"],
    topics: [{ id: "liability", name: "Liability", rules: [{
      id: "liability-cap", name: "Liability cap", concept: "Determine whether liability is capped.",
      scope: "clause", required: true, guidance: "Escalate uncapped liability.",
      standard: { name: "Standard", criteria: "Cap at fees paid in the previous 12 months.", sampleClauses: [{ text: "Liability will not exceed fees paid in the preceding 12 months.", usage: "preferred", sourceRefs: ["T1R2C3"] }] },
      fallbacks: [], unacceptable: [{ name: "Unacceptable", criteria: "Uncapped liability for ordinary breach.", sampleClauses: [] }],
      conditions: [], actions: [], sourceRefs: ["P4", "T1R2C3"],
    }] }],
  },
};

const reviewRun = {
  id: "run-1", playbookId: playbook.id, versionId: playbook.publishedVersionId,
  model: "legal-committee", documentName: "agreement.txt", reviewMode: "strict",
  status: "completed", summary: "One liability provision requires revision.", error: null,
  startedAt: "2026-07-30T11:00:00.000Z", completedAt: "2026-07-30T11:00:04.000Z",
  findings: [{ id: "finding-1", topicId: "liability", ruleId: "liability-cap", ruleName: "Liability cap", status: "unacceptable", quote: "Supplier liability is unlimited.", location: "Section 10", analysis: "The agreement has uncapped supplier liability and does not match an approved position.", suggestedText: "Supplier liability will not exceed fees paid in the preceding 12 months." }],
};

async function mockPlaybooks(page: Page) {
  await page.route("http://localhost:3001/playbooks/configuration", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ configuredModels: [{ id: "legal-committee", label: "Legal Committee", provider: "committee", location: "committee" }] }) }));
  await page.route("http://localhost:3001/playbooks", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify([playbook]) }));
  await page.route(`http://localhost:3001/playbooks/${playbook.id}/review`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(reviewRun) }));
}

test("playbook editor exposes imported concepts, positions, and source clauses", async ({ page }) => {
  await mockPlaybooks(page);
  await page.goto("/playbooks");

  await expect(page.getByText("Customer MSA Playbook").first()).toBeVisible();
  await expect(page.getByLabel("Concept to detect")).toHaveValue("Determine whether liability is capped.");
  expect(await page.locator("textarea").evaluateAll((items) => items.some((item) => (item as HTMLTextAreaElement).value === "Liability will not exceed fees paid in the preceding 12 months."))).toBe(true);
  await expect(page.getByText("Imported from P4, T1R2C3")).toBeVisible();
  await page.screenshot({ path: "/tmp/mike-playbooks-desktop.png", fullPage: true });
});

test("published playbook reviews a supplied document and displays actionable findings", async ({ page }) => {
  await mockPlaybooks(page);
  await page.goto("/playbooks");
  await page.getByRole("button", { name: "Review document" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="file"]').setInputFiles({ name: "agreement.txt", mimeType: "text/plain", buffer: Buffer.from("Supplier liability is unlimited.") });
  await dialog.getByRole("button", { name: "Start review" }).click();

  await expect(page.getByText("One liability provision requires revision.")).toBeVisible();
  await expect(page.getByText("Supplier liability is unlimited.")).toBeVisible();
  await expect(page.getByText("unacceptable", { exact: true })).toBeVisible();
});

test("Word import remains usable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockPlaybooks(page);
  await page.goto("/playbooks");
  await page.getByRole("button", { name: "Import Word" }).click();
  await expect(page.getByRole("dialog")).toContainText("Import Word playbook");
  await page.screenshot({ path: "/tmp/mike-playbooks-mobile.png", fullPage: true });
});

test("Assistant exposes published playbooks in the prompt composer", async ({ page }) => {
  await mockPlaybooks(page);
  await page.goto("/assistant");

  await page.getByRole("button", { name: "Select playbook" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Customer MSA Playbook");
  await expect(dialog).toContainText("Published version 1");
  await dialog.getByRole("button", { name: "Use playbook" }).click();

  await expect(page.getByText("Customer MSA Playbook · v1")).toBeVisible();
  await page.screenshot({ path: "/tmp/mike-assistant-playbook.png", fullPage: true });
});

test("Assistant playbook picker remains usable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockPlaybooks(page);
  await page.goto("/assistant");

  await page.getByRole("button", { name: "Select playbook" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Customer MSA Playbook");
  await dialog.getByRole("button", { name: "Use playbook" }).click();
  await expect(page.getByText("Customer MSA Playbook · v1")).toBeVisible();
  await page.screenshot({ path: "/tmp/mike-assistant-playbook-mobile.png", fullPage: true });
});
