import { expect, test, type Page } from "@playwright/test";

const builtInAnalyze = {
    id: "mike-example-001-test",
    userId: null,
    source: "built_in",
    name: "Red Flag Review of Commercial Agreement",
    prompt: "Review the attached commercial agreement and identify material red flags.",
    description: null,
    promptType: "Assist",
    categories: ["Analyze"],
    practiceAreas: ["Commercial Transactions", "Corporate"],
    sourceRequirements: ["Files"],
    originalCreator: "example@mike.ai",
    originalCreatedAt: "2025-02-08T09:55:10-08:00",
    createdAt: "2026-07-29T18:14:42.184Z",
    updatedAt: "2026-07-29T18:14:42.184Z",
};

const builtInDraft = {
    ...builtInAnalyze,
    id: "mike-example-002-test",
    name: "Draft a Board Resolution",
    prompt: "Draft a board resolution approving the proposed transaction.",
    promptType: "Draft",
    categories: ["Draft"],
    practiceAreas: ["Corporate Governance"],
};

const customPrompt = {
    ...builtInAnalyze,
    id: "custom-prompt-1",
    userId: "e2e-user",
    source: "user",
    name: "My NDA Review",
    prompt: "Review the NDA for confidentiality, exclusions, term, and remedies.",
    description: "Standard NDA review",
    originalCreator: null,
    originalCreatedAt: null,
};

async function mockPromptApi(page: Page) {
    await page.route("http://localhost:3001/prompts", async (route) => {
        if (route.request().method() === "POST") {
            const body = route.request().postDataJSON();
            return route.fulfill({ contentType: "application/json", status: 201, body: JSON.stringify({ ...customPrompt, ...body, id: "created-prompt", source: "user" }) });
        }
        return route.fulfill({ contentType: "application/json", body: JSON.stringify([customPrompt, builtInAnalyze, builtInDraft]) });
    });
    await page.route(/http:\/\/localhost:3001\/prompts\/.+/, (route) => {
        const id = decodeURIComponent(route.request().url().split("/").pop() ?? "");
        const prompt = [customPrompt, builtInAnalyze, builtInDraft].find((item) => item.id === id) ?? builtInAnalyze;
        route.fulfill({ contentType: "application/json", body: JSON.stringify(prompt) });
    });
}

test("prompt library organizes built-ins and custom prompts by category", async ({ page }) => {
    await mockPromptApi(page);
    await page.goto("/prompts");

    await expect(page.getByText("Prompt library", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "My NDA Review" })).toBeVisible();
    await expect(page.getByText("Built-in").first()).toBeVisible();
    await page.getByRole("button", { name: /Draft 1/ }).click();
    await expect(page.getByText("Draft a Board Resolution").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Draft a Board Resolution" })).toBeVisible();
    await expect(page.getByText("Red Flag Review of Commercial Agreement")).not.toBeVisible();
    await page.screenshot({ path: "/tmp/mike-prompt-library-desktop.png", fullPage: true });
});

test("a selected prompt opens prefilled in Assistant", async ({ page }) => {
    await mockPromptApi(page);
    await page.goto("/prompts");
    await page.getByRole("button", { name: "Use prompt" }).click();

    await expect(page).toHaveURL(/\/assistant\?prompt=custom-prompt-1/);
    await expect(page.getByPlaceholder("How can I help?")).toHaveValue(customPrompt.prompt);
});

test("user can save a categorized custom prompt", async ({ page }) => {
    await mockPromptApi(page);
    await page.goto("/prompts");
    await page.getByRole("button", { name: "New" }).click();

    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("Closing checklist");
    await dialog.getByLabel("Prompt").fill("Create a closing checklist from the attached transaction documents.");
    await dialog.getByLabel("Categories").fill("Analyze, Draft");
    await dialog.getByLabel("Source requirements").fill("Files");
    await dialog.getByRole("button", { name: "Save prompt" }).click();

    await expect(page.getByRole("heading", { name: "Closing checklist" })).toBeVisible();
    await expect(page.getByText("Requires files")).toBeVisible();
});

test("Assistant composer can select a prompt from the library", async ({ page }) => {
    await mockPromptApi(page);
    await page.goto("/assistant");
    await page.getByRole("button", { name: "Open prompt library" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Red Flag Review of Commercial Agreement").first()).toBeVisible();
    await dialog.getByText("Red Flag Review of Commercial Agreement").first().click();
    await dialog.getByRole("button", { name: "Use prompt" }).click();
    await expect(page.getByPlaceholder("How can I help?")).toHaveValue(builtInAnalyze.prompt);
});

test("prompt library remains usable on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockPromptApi(page);
    await page.goto("/prompts");
    await expect(page.getByRole("heading", { name: "My NDA Review" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Use prompt" })).toBeVisible();
    await page.screenshot({ path: "/tmp/mike-prompt-library-mobile.png", fullPage: true });
});
