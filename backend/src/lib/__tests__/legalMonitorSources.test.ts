import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const { guardedFetchMock } = vi.hoisted(() => ({ guardedFetchMock: vi.fn() }));
vi.mock("../mcp/client", () => ({ guardedFetch: guardedFetchMock }));

import {
    collectLegalMonitorSourceItems,
    markLegalMonitorSourceItemsProcessed,
    parseFeedXml,
    parseOpmlSources,
    replaceLegalMonitorSources,
    validateLegalMonitorSources,
} from "../legalMonitorSources";
import { createServerSQLite } from "../sqlite";

const monitorIds: string[] = [];

afterEach(async () => {
    guardedFetchMock.mockReset();
    const db = createServerSQLite();
    for (const monitorId of monitorIds.splice(0)) {
        await db.from("legal_monitor_source_items").delete().eq("monitor_id", monitorId);
        await db.from("legal_monitor_sources").delete().eq("monitor_id", monitorId);
    }
});

describe("legal monitor source parsing", () => {
    it("normalizes RSS and Atom entries", () => {
        const rss = parseFeedXml(`<?xml version="1.0"?><rss version="2.0"><channel><title>OCC</title><item><guid>occ-1</guid><title>New Bulletin</title><link>https://example.com/bulletin</link><pubDate>Wed, 29 Jul 2026 12:00:00 GMT</pubDate><description><![CDATA[<p>Material <strong>guidance</strong>.</p>]]></description></item></channel></rss>`);
        const atom = parseFeedXml(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Register</title><entry><id>rule-1</id><title>Open Banking Rule</title><link rel="alternate" href="https://example.com/rule"/><updated>2026-07-29T13:00:00Z</updated><summary>Final rule text</summary></entry></feed>`);

        expect(rss).toEqual([expect.objectContaining({ title: "New Bulletin", url: "https://example.com/bulletin", summary: "Material guidance." })]);
        expect(atom).toEqual([expect.objectContaining({ title: "Open Banking Rule", url: "https://example.com/rule", publishedAt: "2026-07-29T13:00:00.000Z" })]);
    });

    it("imports nested OPML categories", () => {
        const sources = parseOpmlSources(`<?xml version="1.0"?><opml version="2.0"><body><outline text="Federal"><outline text="OCC" type="rss" xmlUrl="https://example.com/occ.xml"/></outline><outline text="Trade"><outline title="Payments" xmlUrl="https://example.com/payments.xml"/></outline></body></opml>`);
        expect(sources).toEqual([
            expect.objectContaining({ name: "OCC", category: "Federal", kind: "rss" }),
            expect.objectContaining({ name: "Payments", category: "Trade", kind: "rss" }),
        ]);
    });

    it("rejects insecure and duplicate source URLs", () => {
        expect(() => validateLegalMonitorSources([{ kind: "rss", name: "Bad", url: "http://example.com/feed", enabled: true }])).toThrow(/HTTPS/);
        expect(() => validateLegalMonitorSources([
            { kind: "rss", name: "One", url: "https://example.com/feed", enabled: true },
            { kind: "rss", name: "Two", url: "https://example.com/feed", enabled: true },
        ])).toThrow(/Duplicate/);
    });
});

describe("legal monitor source persistence", () => {
    it("preserves checkpoints when a source is edited and removes omitted sources", async () => {
        const userId = crypto.randomUUID();
        const monitorId = crypto.randomUUID();
        monitorIds.push(monitorId);
        const first = await replaceLegalMonitorSources(userId, monitorId, [
            { kind: "rss", name: "OCC", url: "https://example.com/occ.xml", category: "Federal", enabled: true },
            { kind: "web", name: "Rules", url: "https://example.com/rules", category: null, enabled: true },
        ]);
        const updated = await replaceLegalMonitorSources(userId, monitorId, [
            { ...first[0], name: "OCC Bulletins", enabled: false },
        ]);

        expect(updated).toHaveLength(1);
        expect(updated[0]).toMatchObject({ id: first[0].id, name: "OCC Bulletins", enabled: false });
        const db = createServerSQLite();
        const removed = await db.from("legal_monitor_sources").select("id").eq("id", first[1].id).maybeSingle();
        expect(removed.data).toBeNull();
    });

    it("checkpoints HTTP metadata and keeps items pending until analysis succeeds", async () => {
        const userId = crypto.randomUUID();
        const monitorId = crypto.randomUUID();
        monitorIds.push(monitorId);
        await replaceLegalMonitorSources(userId, monitorId, [
            { kind: "rss", name: "OCC", url: "https://example.com/occ.xml", category: "Federal", enabled: true },
        ]);
        guardedFetchMock.mockResolvedValueOnce(new Response(
            `<rss version="2.0"><channel><item><guid>item-1</guid><title>Bulletin</title><link>https://example.com/item-1</link><pubDate>${new Date().toUTCString()}</pubDate><description>New guidance.</description></item></channel></rss>`,
            { status: 200, headers: { "content-type": "application/rss+xml", etag: '"v1"', "last-modified": new Date().toUTCString() } },
        ));

        const first = await collectLegalMonitorSourceItems(userId, monitorId, 14, 50);
        expect(first).toMatchObject({ sourceCount: 1, errors: [] });
        expect(first.items).toEqual([expect.objectContaining({ title: "Bulletin", sourceName: "OCC" })]);

        await markLegalMonitorSourceItemsProcessed(userId, first.items.map((item) => item.id), new Date().toISOString());
        guardedFetchMock.mockResolvedValueOnce(new Response(null, { status: 304 }));
        const second = await collectLegalMonitorSourceItems(userId, monitorId, 14, 50);
        expect(second.items).toEqual([]);
        expect(guardedFetchMock.mock.calls[1][1].headers).toMatchObject({ "If-None-Match": '"v1"' });
    });

    it("records a source failure without manufacturing an item", async () => {
        const userId = crypto.randomUUID();
        const monitorId = crypto.randomUUID();
        monitorIds.push(monitorId);
        await replaceLegalMonitorSources(userId, monitorId, [
            { kind: "rss", name: "Unavailable", url: "https://example.com/down.xml", enabled: true },
        ]);
        guardedFetchMock.mockRejectedValueOnce(new Error("connection failed"));

        const result = await collectLegalMonitorSourceItems(userId, monitorId, 14, 50);
        expect(result).toMatchObject({ sourceCount: 1, items: [], errors: ["Unavailable: connection failed"] });
    });
});
