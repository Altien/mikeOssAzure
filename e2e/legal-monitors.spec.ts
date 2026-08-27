import { expect, test } from "@playwright/test";

const monitor = {
    id: "monitor-1",
    userId: "e2e-user",
    name: "Court AI developments",
    topic: "Judicial treatment of generative AI evidence and attorney filing obligations",
    jurisdiction: "United States federal",
    sourceTypes: ["case_law", "statutes"],
    connectorId: "dingduff-1",
    connectorName: "DingDuff Legal Research",
    connectorConfig: { mode: "agent" },
    sources: [{
        id: "source-1", monitorId: "monitor-1", kind: "rss", name: "OCC Bulletins",
        url: "https://www.occ.gov/rss/occ_bulletins.xml", category: "Federal Banking Regulators",
        enabled: true, lastCheckedAt: "2026-07-29T12:00:00.000Z", lastSuccessAt: "2026-07-29T12:00:00.000Z",
        lastError: null, itemCount: 18, createdAt: "2026-07-20T12:00:00.000Z", updatedAt: "2026-07-29T12:00:00.000Z",
    }],
    referenceDocuments: [{
        id: "library-doc-1",
        filename: "AI filing policy.docx",
        fileType: "docx",
        sizeBytes: 4096,
        versionNumber: 2,
        status: "ready",
        updatedAt: "2026-07-29T10:00:00.000Z",
    }],
    model: "legal-committee",
    intervalHours: 24,
    lookbackDays: 14,
    maxItemsPerRun: 50,
    alertEmail: "e2e@mike.local",
    emailEnabled: true,
    enabled: true,
    nextRunAt: "2026-07-30T12:00:00.000Z",
    lastRunAt: "2026-07-29T12:00:00.000Z",
    lastStatus: "completed",
    lastError: null,
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-29T12:00:00.000Z",
};

const run = {
    id: "run-1",
    monitorId: monitor.id,
    userId: monitor.userId,
    status: "completed",
    summary: "A federal court issued a new standing order governing disclosure of generative AI use.",
    report: "## Analysis\n\nThe standing order requires counsel to verify AI-assisted citations before filing.",
    developments: [
        {
            title: "Standing Order on Generative AI Filings",
            type: "case_law",
            date: "2026-07-28",
            url: "https://example.com/standing-order",
            citation: "Standing Order 26-4",
            sourceName: "DingDuff Legal Research",
            whyItMatters: "It creates a new verification duty for filings in the district.",
        },
    ],
    hasMaterialUpdates: true,
    toolCalls: 4,
    sourceItemCount: 3,
    sourceErrors: [],
    emailStatus: "sent",
    emailError: null,
    error: null,
    startedAt: "2026-07-29T11:58:00.000Z",
    completedAt: "2026-07-29T12:00:00.000Z",
};

async function mockMonitorApi(page: import("@playwright/test").Page) {
    await page.route("http://localhost:3001/legal-monitors/configuration", (route) =>
        route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
                connectors: [{
                    id: "dingduff-1", name: "DingDuff Legal Research",
                    transport: "streamable_http", serverUrl: "https://example.com/mcp",
                    authType: "none", enabled: true, hasAuthConfig: false,
                    customHeaderKeys: [], oauthConnected: false, toolPolicy: {},
                    tools: [], toolCount: 2,
                    createdAt: monitor.createdAt, updatedAt: monitor.updatedAt,
                }],
                configuredModels: [{ id: "legal-committee", label: "Legal Committee", provider: "committee", location: "committee" }],
                intervals: [6, 12, 24, 72, 168, 336, 720],
                emailAvailable: true,
                defaultEmail: "e2e@mike.local",
                presets: [{
                    id: "fintech-gc-digest", name: "Fintech GC Regulatory Digest", description: "Fintech digest",
                    monitor: { name: "Fintech GC Regulatory Digest", topic: "Monitor banking and payments regulation.", jurisdiction: "United States", sourceTypes: ["case_law", "statutes"], intervalHours: 24, lookbackDays: 14, maxItemsPerRun: 50 },
                    sources: [{ kind: "rss", name: "OCC Bulletins", url: "https://www.occ.gov/rss/occ_bulletins.xml", category: "Federal", enabled: true }],
                }],
            }),
        }),
    );
    await page.route(`http://localhost:3001/legal-monitors/${monitor.id}/runs`, (route) =>
        route.fulfill({ contentType: "application/json", body: JSON.stringify([run]) }),
    );
    await page.route("http://localhost:3001/legal-monitors", (route) =>
        route.fulfill({ contentType: "application/json", body: JSON.stringify([monitor]) }),
    );
}

test("legal monitors page renders schedule, findings, and history", async ({ page }) => {
    await mockMonitorApi(page);
    await page.goto("/legal-monitors");

    await expect(page.getByRole("heading", { name: monitor.name })).toBeVisible();
    await expect(page.getByText("1 material development")).toBeVisible();
    await expect(page.getByText("Standing Order on Generative AI Filings")).toBeVisible();
    await expect(page.getByText("DingDuff Legal Research", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("OCC Bulletins")).toBeVisible();
    await expect(page.getByText("18 items · checked")).toBeVisible();
    await expect(page.getByText("AI filing policy.docx")).toBeVisible();
    await expect(page.getByText("1 context file")).toBeVisible();
    await expect(page.getByRole("button", { name: "Run now" })).toBeEnabled();
    await expect(page.getByText("Alert sent")).toBeVisible();
    await page.screenshot({ path: "/tmp/mike-legal-monitors-desktop.png", fullPage: true });
});

test("monitor editor selects additional context from Library files", async ({ page }) => {
    await mockMonitorApi(page);
    await page.route("http://localhost:3001/library/files", (route) =>
        route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
                folders: [],
                documents: [
                    {
                        id: "library-doc-1", project_id: null, filename: "AI filing policy.docx",
                        file_type: "docx", storage_path: "documents/e2e/library-doc-1/source.docx",
                        pdf_storage_path: null, size_bytes: 4096, page_count: 2, structure_tree: null,
                        status: "ready", created_at: "2026-07-20T12:00:00.000Z", updated_at: "2026-07-29T10:00:00.000Z",
                        active_version_number: 2,
                    },
                    {
                        id: "library-doc-2", project_id: null, filename: "Competition risk matrix.pdf",
                        file_type: "pdf", storage_path: "documents/e2e/library-doc-2/source.pdf",
                        pdf_storage_path: "documents/e2e/library-doc-2/source.pdf", size_bytes: 8192, page_count: 4, structure_tree: null,
                        status: "ready", created_at: "2026-07-22T12:00:00.000Z", updated_at: "2026-07-29T11:00:00.000Z",
                        active_version_number: 1,
                    },
                ],
            }),
        }),
    );
    await page.goto("/legal-monitors");
    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByRole("button", { name: "Add files" }).click();

    await page.getByText("Competition risk matrix.pdf").click();
    await page.getByRole("button", { name: "Add selected" }).click();

    const editor = page.getByRole("dialog");
    await expect(editor.getByText("Competition risk matrix.pdf")).toBeVisible();
    await expect(editor.getByText("AI filing policy.docx")).toBeVisible();
});

test("fintech preset opens as an editable mixed-source monitor", async ({ page }) => {
    await page.route("http://localhost:3001/legal-monitors/configuration", (route) =>
        route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
                connectors: [], configuredModels: [{ id: "legal-committee", label: "Legal Committee", provider: "committee", location: "committee" }],
                intervals: [24, 168], emailAvailable: false, defaultEmail: "",
                presets: [{
                    id: "fintech-gc-digest", name: "Fintech GC Regulatory Digest", description: "Fintech digest",
                    monitor: { name: "Fintech GC Regulatory Digest", topic: "Monitor banking and payments regulation.", jurisdiction: "United States", sourceTypes: ["case_law", "statutes"], intervalHours: 24, lookbackDays: 14, maxItemsPerRun: 50 },
                    sources: [{ kind: "rss", name: "OCC Bulletins", url: "https://www.occ.gov/rss/occ_bulletins.xml", category: "Federal", enabled: true }],
                }],
            }),
        }),
    );
    await page.route("http://localhost:3001/legal-monitors", (route) =>
        route.fulfill({ contentType: "application/json", body: "[]" }),
    );
    await page.goto("/legal-monitors");
    await page.getByRole("button", { name: "Fintech GC Regulatory Digest" }).first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.locator('input[value="Fintech GC Regulatory Digest"]')).toBeVisible();
    await expect(dialog.locator('input[value="OCC Bulletins"]')).toBeVisible();
    await expect(dialog.getByText("1 configured")).toBeVisible();
});

test("trademark preset selects the patent connector and exposes prefix filters", async ({ page }) => {
    await page.route("http://localhost:3001/legal-monitors/configuration", (route) =>
        route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
                connectors: [{
                    id: "patent-1", name: "USPTO Patent & Trademark",
                    transport: "stdio", managed: true, serverUrl: "builtin://patent-mcp-server@0.9.5",
                    authType: "none", enabled: true, hasAuthConfig: false,
                    customHeaderKeys: [], oauthConnected: false, toolPolicy: {},
                    tools: [{
                        id: "tool-1", toolName: "tm_search_trademarks", openaiToolName: "mcp_tm_search",
                        title: "Search trademarks", description: "Search federal trademarks", enabled: true,
                        readOnly: true, destructive: false, requiresConfirmation: false, lastSeenAt: "2026-07-30T12:00:00.000Z",
                    }], toolCount: 1, createdAt: "2026-07-30T12:00:00.000Z", updatedAt: "2026-07-30T12:00:00.000Z",
                }],
                configuredModels: [{ id: "legal-committee", label: "Legal Committee", provider: "committee", location: "committee" }],
                intervals: [24, 168], emailAvailable: false, defaultEmail: "",
                presets: [{
                    id: "trademark-prefix-watch", name: "Trademark Prefix Watch", description: "Trademark registrations",
                    requiredToolName: "tm_search_trademarks",
                    monitor: {
                        name: "Trademark Prefix Watch", topic: "Review new registrations.", jurisdiction: "United States federal trademarks",
                        sourceTypes: [], connectorConfig: { mode: "trademark_prefix", prefix: "", status: "live", internationalClass: null },
                        intervalHours: 24, lookbackDays: 14, maxItemsPerRun: 50,
                    },
                    sources: [],
                }],
            }),
        }),
    );
    await page.route("http://localhost:3001/legal-monitors", (route) =>
        route.fulfill({ contentType: "application/json", body: "[]" }),
    );
    await page.goto("/legal-monitors");
    await page.getByRole("button", { name: "Trademark Prefix Watch" }).first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "Connector" })).toContainText("USPTO Patent & Trademark");
    await expect(dialog.getByRole("button", { name: "Retrieval mode" })).toContainText("Trademark prefix watch");
    await dialog.getByLabel("Mark begins with").fill("ACME");
    await expect(dialog.getByRole("button", { name: "Save monitor" })).toBeEnabled();
});

test("legal monitors page remains usable on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockMonitorApi(page);
    await page.goto("/legal-monitors");

    await expect(page.getByText(monitor.name).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Run now" })).toBeVisible();
    await expect(page.getByText("Standing Order on Generative AI Filings")).toBeVisible();
    await page.screenshot({ path: "/tmp/mike-legal-monitors-mobile.png", fullPage: true });
});
