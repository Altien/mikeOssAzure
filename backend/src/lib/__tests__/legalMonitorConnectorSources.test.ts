import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
    buildTrademarkPrefixQuery,
    collectTrademarkPrefixSource,
    deleteLegalMonitorConnectorSourceData,
    extractTrademarkSearchPage,
    markLegalMonitorConnectorItemsProcessed,
    parseLegalMonitorConnectorConfig,
} from "../legalMonitorConnectorSources";
import type { McpConnectorSummary } from "../mcpConnectors";

const monitorIds: Array<{ userId: string; monitorId: string }> = [];

afterEach(async () => {
    for (const { userId, monitorId } of monitorIds.splice(0)) {
        await deleteLegalMonitorConnectorSourceData(userId, monitorId);
    }
});

describe("trademark monitor connector configuration", () => {
    it("normalizes a trademark prefix watch", () => {
        expect(parseLegalMonitorConnectorConfig({
            mode: "trademark_prefix",
            prefix: "  ACME   BANK ",
            status: "all",
            internationalClass: "09",
        })).toEqual({
            mode: "trademark_prefix",
            prefix: "ACME BANK",
            status: "all",
            internationalClass: "9",
        });
    });

    it("rejects invalid trademark classes and empty prefixes", () => {
        expect(() => parseLegalMonitorConnectorConfig({
            mode: "trademark_prefix",
            prefix: "",
            status: "live",
            internationalClass: null,
        })).toThrow(/prefix is required/i);
        expect(() => parseLegalMonitorConnectorConfig({
            mode: "trademark_prefix",
            prefix: "ACME",
            status: "live",
            internationalClass: "46",
        })).toThrow(/1 through 45/i);
    });
});

describe("trademark connector result handling", () => {
    it("builds a date-bounded escaped prefix query", () => {
        expect(buildTrademarkPrefixQuery("ACME+BANK", "2026-07-29"))
            .toBe("wordmark:ACME\\+BANK* AND registrationDate:[2026-07-29 TO *]");
        expect(buildTrademarkPrefixQuery("ACME BANK", "2026-07-29"))
            .toBe("wordmark:(ACME AND BANK*) AND registrationDate:[2026-07-29 TO *]");
    });

    it("extracts a structured result from MCP text content", () => {
        const envelope = {
            success: true,
            results: [{ id: "98765432", wordmark: "ACME BANK", registrationDate: "2026-07-29" }],
            total: 2,
            offset: 0,
            has_more: true,
        };
        const content = JSON.stringify({
            result: {
                content: [{ type: "text", text: JSON.stringify(envelope) }],
            },
            note: "untrusted",
        });
        expect(extractTrademarkSearchPage(content)).toEqual({
            results: envelope.results,
            total: 2,
            hasMore: true,
        });
    });

    it("rejects malformed connector output", () => {
        expect(() => extractTrademarkSearchPage(JSON.stringify({ result: { content: [] } })))
            .toThrow(/unsupported response shape/i);
    });

    it("keeps records pending when they do not fit in one analysis dossier", async () => {
        const userId = crypto.randomUUID();
        const monitorId = crypto.randomUUID();
        monitorIds.push({ userId, monitorId });
        const connector: McpConnectorSummary = {
            id: crypto.randomUUID(),
            name: "USPTO Patent & Trademark",
            transport: "stdio",
            managed: true,
            serverUrl: "builtin://patent",
            authType: "none",
            enabled: true,
            hasAuthConfig: false,
            customHeaderKeys: [],
            oauthConnected: false,
            toolPolicy: {},
            tools: [{
                id: crypto.randomUUID(),
                toolName: "tm_search_trademarks",
                openaiToolName: "mcp_tm_search",
                title: "Search trademarks",
                description: "Search trademarks",
                enabled: true,
                readOnly: true,
                destructive: false,
                requiresConfirmation: false,
                lastSeenAt: new Date().toISOString(),
            }],
            toolCount: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        const records = Array.from({ length: 30 }, (_, index) => ({
            id: String(90_000_000 + index),
            wordmark: `ACME ${String(index).padStart(2, "0")}`,
            registrationId: String(8_000_000 + index),
            // Keep the date inside the test's 14-day lookback window — a
            // hardcoded date silently ages out of the window and the
            // collector then finds zero records.
            registrationDate: new Date(
                Date.now() - 2 * 24 * 60 * 60 * 1000,
            ).toISOString().slice(0, 10),
            ownerName: [`Owner ${index} ${"x".repeat(500)}`],
            internationalClass: ["IC 009"],
            statusDescription: "REGISTERED",
            goodsAndServices: [`Software ${"y".repeat(2_000)}`],
            markDescription: ["z".repeat(1_000)],
        }));
        const executeTool = async (
            _userId: string,
            _toolName: string,
            args: Record<string, unknown>,
        ) => {
            const offset = Number(args.offset);
            const page = records.slice(offset, offset + 5);
            const envelope = {
                success: true,
                results: page,
                total: records.length,
                offset,
                has_more: offset + page.length < records.length,
            };
            return {
                content: JSON.stringify({
                    result: { content: [{ type: "text", text: JSON.stringify(envelope) }] },
                }),
                event: {
                    type: "mcp_tool_call" as const,
                    connector_id: connector.id,
                    connector_name: connector.name,
                    tool_name: "tm_search_trademarks",
                    openai_tool_name: "mcp_tm_search",
                    status: "ok" as const,
                },
            };
        };
        const collect = () => collectTrademarkPrefixSource({
            userId,
            monitorId,
            connector,
            config: { mode: "trademark_prefix", prefix: "ACME", status: "live", internationalClass: null },
            lookbackDays: 14,
            previousCompletedAt: null,
            maxItems: 100,
            executeTool,
        });

        const first = await collect();
        expect(first.itemCount).toBeGreaterThan(0);
        expect(first.itemCount).toBeLessThan(records.length);
        await markLegalMonitorConnectorItemsProcessed(userId, first.itemIds, new Date().toISOString());

        const second = await collect();
        expect(second.itemCount).toBe(records.length - first.itemCount);
        expect(new Set([...first.itemIds, ...second.itemIds]).size).toBe(records.length);
        await markLegalMonitorConnectorItemsProcessed(userId, second.itemIds, new Date().toISOString());

        await expect(collect()).resolves.toMatchObject({ itemCount: 0, itemIds: [] });
    });
});
