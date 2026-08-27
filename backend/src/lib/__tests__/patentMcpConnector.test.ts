import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
    deleteUserMcpConnector,
    PATENT_MCP_SERVER_URI,
    provisionPatentMcpConnector,
    stringifyMcpResult,
    updateUserMcpConnector,
} from "../mcp/servers";
import { createServerSQLite } from "../sqlite";

const userIds: string[] = [];

afterEach(async () => {
    const db = createServerSQLite();
    for (const userId of userIds.splice(0)) {
        const { data: connectors } = await db
            .from("user_mcp_connectors")
            .select("id")
            .eq("user_id", userId);
        const connectorIds = (connectors ?? []).map((row) => String(row.id));
        if (connectorIds.length) {
            await db
                .from("user_mcp_connector_tools")
                .delete()
                .in("connector_id", connectorIds);
        }
        await db.from("user_mcp_connectors").delete().eq("user_id", userId);
    }
});

function newUserId() {
    const userId = crypto.randomUUID();
    userIds.push(userId);
    return userId;
}

describe("managed patent MCP connector", () => {
    it("keeps oversized MCP tool results valid JSON", () => {
        const content = stringifyMcpResult({ content: "x".repeat(100_000) });
        expect(() => JSON.parse(content)).not.toThrow();
        expect(JSON.parse(content)).toMatchObject({
            result: { truncated: true },
        });
    });

    it("provisions one idempotent managed stdio connector per user", async () => {
        const userId = newUserId();

        const first = await provisionPatentMcpConnector(userId);
        const second = await provisionPatentMcpConnector(userId);

        expect(second.id).toBe(first.id);
        expect(first).toMatchObject({
            name: "USPTO Patent & Trademark",
            transport: "stdio",
            managed: true,
            serverUrl: PATENT_MCP_SERVER_URI,
            enabled: true,
            authType: "none",
        });
        expect(first.toolPolicy).toMatchObject({
            managed: "patent_mcp_server",
            package: "patent-mcp-server==0.9.5",
            python: "3.13",
            mcp: "mcp[cli]>=1.28,<2",
        });
    });

    it("allows disabling but prevents repointing or deleting the managed connector", async () => {
        const userId = newUserId();
        const connector = await provisionPatentMcpConnector(userId);

        const disabled = await updateUserMcpConnector(userId, connector.id, {
            enabled: false,
        });
        expect(disabled.enabled).toBe(false);

        await expect(
            updateUserMcpConnector(userId, connector.id, {
                serverUrl: "https://example.com/mcp",
            }),
        ).rejects.toThrow("Managed local connector settings cannot be changed");
        await expect(
            deleteUserMcpConnector(userId, connector.id),
        ).rejects.toThrow("Managed local connectors cannot be deleted");
    });
});
