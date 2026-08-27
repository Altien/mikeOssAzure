import { expect, test } from "@playwright/test";

const connector = {
    id: "patent-connector-test",
    name: "USPTO Patent & Trademark",
    transport: "stdio",
    managed: true,
    serverUrl: "builtin://patent-mcp-server@0.9.5",
    authType: "none",
    enabled: true,
    hasAuthConfig: false,
    customHeaderKeys: [],
    oauthConnected: false,
    toolPolicy: {
        managed: "patent_mcp_server",
        package: "patent-mcp-server==0.9.5",
    },
    tools: [
        {
            id: "tool-1",
            toolName: "search_patents",
            openaiToolName: "mcp_patent_search_patents",
            title: "Search patents",
            description: "Search public patent records",
            enabled: true,
            readOnly: true,
            destructive: false,
            requiresConfirmation: false,
            lastSeenAt: "2026-07-30T12:00:00.000Z",
        },
    ],
    toolCount: 1,
    createdAt: "2026-07-30T12:00:00.000Z",
    updatedAt: "2026-07-30T12:00:00.000Z",
};

test("provisions and displays the managed USPTO connector", async ({ page }) => {
    let provisioned = false;
    await page.route("http://localhost:3001/user/mcp-connectors", (route) => {
        if (route.request().method() === "GET") {
            return route.fulfill({
                contentType: "application/json",
                body: JSON.stringify(provisioned ? [connector] : []),
            });
        }
        return route.continue();
    });
    await page.route(
        "http://localhost:3001/user/mcp-connectors/presets/patent",
        (route) => {
            provisioned = true;
            return route.fulfill({
                status: 201,
                contentType: "application/json",
                body: JSON.stringify(connector),
            });
        },
    );

    await page.goto("/settings/connectors");
    await page.getByRole("button", { name: "USPTO" }).click();

    const dialog = page.getByRole("dialog");
    await expect(
        dialog.getByText("Local stdio · patent-mcp-server 0.9.5"),
    ).toBeVisible();
    await expect(dialog.getByText("Search patents")).toBeVisible();
    await expect(
        page.getByRole("button", { name: "Delete connector" }),
    ).toHaveCount(0);
});
