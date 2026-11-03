import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/node";
import type { Db } from "../../lib/supabase";
import { markStage, resetSentryForTests, scrubEvent, setOperation } from "../../lib/observability/sentry";
import { privacyBoundaryIntegration } from "../../lib/observability/sentryPrivacy";

const sweeps = vi.hoisted(() => ({
    text: vi.fn(), documents: vi.fn(), cells: vi.fn(), organizations: vi.fn(), subagents: vi.fn(),
    captureCleanup: vi.fn(), completeCleanup: vi.fn(),
}));
vi.mock("../../modules/documents/documents.service", () => ({
    backfillDocumentText: sweeps.text,
    sweepStaleProcessingDocuments: sweeps.documents,
    captureInlineDocumentCleanup: sweeps.captureCleanup,
    completeInlineDocumentCleanup: sweeps.completeCleanup,
}));
vi.mock("../../modules/tabular/tabular.service", () => ({ sweepStaleGeneratingCells: sweeps.cells }));
vi.mock("../../modules/chat/chat.service", () => ({ purgeExpiredSubagentRuns: sweeps.subagents }));
vi.mock("../../modules/orgs/orgs.service", async () => ({
    // Exercise the real archive service through the timer's reporting boundary.
    expireDepartureArchives: (await vi.importActual<typeof import("../../modules/orgs/orgs.retention")>("../../modules/orgs/orgs.retention")).expireDepartureArchives,
    purgeExpiredOrganizations: sweeps.organizations,
}));
const tenancy = vi.hoisted(() => ({ mode: "single" as "single" | "pooled" }));
vi.mock("../../lib/tenancyMode", () => ({ getTenancyMode: async () => tenancy.mode }));
import { runDocumentTextBackfill, runStaleWorkSweep } from "../maintenance";

const PRIVATE = "SYNTHETIC_CLIENT_Jane_Doe_NDA.pdf jane@example.test";
function database(failureAt?: "load" | "expire") {
    const cause = { code: "42501", message: PRIVATE, details: PRIVATE, hint: PRIVATE };
    // Multi-tenant sweeps first find the tenants with work (select tenant_id,
    // via the platform client), then run the sweep as each of them.
    const query = (columns: string) => {
        const chain: Record<string, unknown> = {};
        for (const method of ["lte", "order", "limit", "eq", "in", "gt"]) chain[method] = () => chain;
        chain.then = (resolve: (value: unknown) => unknown) =>
            Promise.resolve(columns === "tenant_id"
                ? { data: [{ tenant_id: "tenant-a" }], error: null }
                : { data: [], error: failureAt === "load" ? cause : null }).then(resolve);
        return chain;
    };
    return {
        from: vi.fn(() => ({ select: (columns: string) => query(columns) })),
        rpc: vi.fn(async () => ({ data: 1, error: failureAt === "expire" ? cause : null })),
    };
}

let warnings: unknown[][];
beforeEach(() => {
    vi.resetAllMocks();
    warnings = [];
    vi.spyOn(console, "warn").mockImplementation((...args) => { warnings.push(args); });
    sweeps.captureCleanup.mockResolvedValue([]);
});
afterEach(async () => {
    await Sentry.close();
    resetSentryForTests("community");
    vi.restoreAllMocks();
});

it.each([
    ["community", "load"], ["community", "expire"],
    ["official", "load"], ["official", "expire"],
] as const)("reports all sweeps once and preserves archive %s/%s diagnostics without private data", async (install, failureAt) => {
    const events: Sentry.ErrorEvent[] = [];
    resetSentryForTests(install, { initialized: true });
    Sentry.init({
        dsn: "https://test@sentry.invalid/1", defaultIntegrations: false,
        integrations: [privacyBoundaryIntegration(), Sentry.captureConsoleIntegration({ levels: ["error"] })],
        beforeSend: scrubEvent,
        transport: () => ({
            send: async envelope => {
                for (const [header, payload] of envelope[1]) {
                    if (header.type === "event") events.push(payload as Sentry.ErrorEvent);
                }
                return { statusCode: 200 };
            },
            flush: async () => true,
        }),
    });
    setOperation("outside.sweep");
    const cause = { code: "ECONNRESET", message: PRIVATE };
    for (const sweep of [sweeps.text, sweeps.cells, sweeps.organizations, sweeps.subagents]) sweep.mockRejectedValue(cause);
    sweeps.documents.mockImplementation(async () => {
        markStage("documents-only");
        await Promise.resolve();
        throw new Error(PRIVATE, { cause });
    });
    const db = database(failureAt);
    await expect(runStaleWorkSweep(db as unknown as Db, () => db as unknown as Db)).resolves.toEqual({ documents: 0, cells: 0 });
    await Sentry.flush(2000);

    expect(events).toHaveLength(6);
    expect(events.map(event => event.tags?.operation)).toEqual([
        "maintenance.document_text", "maintenance.documents", "maintenance.cells",
        "maintenance.organization_archives", "maintenance.organizations", "maintenance.subagent_runs",
    ]);
    for (const event of events) {
        expect(event.tags?.component).toBe("stale-sweep");
        const archive = event.tags?.operation === "maintenance.organization_archives";
        expect(event.tags?.error_kind).toBe(archive ? "db.query_failed" : "maintenance.sweep_failed");
        expect(event.tags?.failure_code).toBe(archive ? "42501" : "ECONNRESET");
        const values = event.exception?.values ?? [];
        expect(values.some(value => value.value?.includes(`Failure in ${String(event.tags?.operation)}`))).toBe(true);
        expect(values.some(value => value.stacktrace?.frames?.length)).toBe(true);
        if (event.tags?.operation !== "maintenance.documents") {
            expect(JSON.stringify(event.breadcrumbs ?? [])).not.toContain("documents-only");
        }
    }
    expect(Sentry.getIsolationScope().getScopeData().tags.operation).toBe("outside.sweep");
    expect(JSON.stringify(events)).not.toContain(PRIVATE);
    expect(JSON.stringify(warnings)).not.toContain(PRIVATE);
    expect(sweeps.completeCleanup).not.toHaveBeenCalled();
    if (failureAt === "load") expect(db.rpc).not.toHaveBeenCalled();
    else expect(db.rpc).toHaveBeenCalledWith("expire_org_departure_archives", { p_limit: 100 });
});

it("preserves successful sweep counts and completes archive cleanup", async () => {
    sweeps.documents.mockResolvedValue(7);
    sweeps.cells.mockResolvedValue(9);
    const db = database();
    const tenantDb = database();
    await expect(runStaleWorkSweep(db as unknown as Db, () => tenantDb as unknown as Db)).resolves.toEqual({ documents: 7, cells: 9 });
    // Tenant-writing sweeps use the tenant client; the plain delete stays platform.
    expect(sweeps.completeCleanup).toHaveBeenCalledWith(tenantDb, []);
    expect(sweeps.text).toHaveBeenCalledWith(tenantDb, { inlineDb: db });
    expect(sweeps.organizations).toHaveBeenCalledWith(tenantDb);
    expect(tenantDb.rpc).toHaveBeenCalledWith("expire_org_departure_archives", { p_limit: 100 });
    expect(sweeps.subagents).toHaveBeenCalledWith(db);
    expect(warnings).toEqual([]);
});

it("runs each tenant-writing sweep inside the tenant that has the work", async () => {
    const { currentTenant } = await import("../../lib/tenantContext.js");
    const seen: (string | undefined)[] = [];
    sweeps.organizations.mockImplementation(async () => { seen.push(currentTenant()?.tenantId); return 0; });
    const db = database();
    await runStaleWorkSweep(db as unknown as Db, () => db as unknown as Db);
    expect(seen).toEqual(["tenant-a"]);
});

// Platform-side tenant discovery: "tenants" answers status (keyset-paged by
// tenant_id), work tables answer which of the asked-for tenants have rows.
function tenantTable(rows: Record<string, string[]>, status: Record<string, string>) {
    const queries: { table: string; filters: unknown[][] }[] = [];
    const db = {
        from: vi.fn((table: string) => ({
            select: () => {
                const filters: unknown[][] = [];
                queries.push({ table, filters });
                const chain: Record<string, unknown> = {};
                for (const method of ["lte", "order", "limit", "eq", "in", "gt"]) {
                    chain[method] = (...args: unknown[]) => { filters.push([method, ...args]); return chain; };
                }
                chain.then = (resolve: (value: unknown) => unknown) => {
                    let ids = rows[table] ?? Object.keys(status).sort();
                    for (const [method, column, value] of filters) {
                        if (method === "in" && column === "tenant_id") ids = ids.filter((id) => (value as string[]).includes(id));
                        if (table === "tenants" && method === "in" && column === "status") ids = ids.filter((id) => (value as string[]).includes(status[id]));
                        if (method === "gt" && column === "tenant_id") ids = ids.filter((id) => id > String(value));
                    }
                    const limit = filters.find(([method]) => method === "limit")?.[1] as number | undefined;
                    return Promise.resolve({ data: ids.slice(0, limit ?? ids.length).map((tenant_id) => ({ tenant_id })), error: null }).then(resolve);
                };
                return chain;
            },
        })),
        rpc: vi.fn(async () => ({ data: 0, error: null })),
    };
    return { db, queries };
}

it("finds every sweepable tenant even when one tenant has a backlog over the page size", async () => {
    const { currentTenant } = await import("../../lib/tenantContext.js");
    const organizations: (string | undefined)[] = [];
    const text: (string | undefined)[] = [];
    sweeps.organizations.mockImplementation(async () => { organizations.push(currentTenant()?.tenantId); return 0; });
    sweeps.text.mockImplementation(async () => { text.push(currentTenant()?.tenantId); return 0; });
    const { db, queries } = tenantTable(
        { organizations: [...Array(1500).fill("tenant-big"), "tenant-small", "tenant-gone", "tenant-held", "tenant-new"] },
        { "tenant-big": "active", "tenant-small": "active", "tenant-gone": "offboarding",
            "tenant-held": "suspended", "tenant-new": "pending" },
    );
    await runStaleWorkSweep(db as unknown as Db, () => db as unknown as Db);
    // Suspended tenants keep deadline-driven deletions; offboarding and
    // pending tenants get no sweep writes.
    expect(organizations).toEqual(["tenant-big", "tenant-held", "tenant-small"]);
    // The tenant-level sweep reads the tenants table directly.
    expect(text).toEqual(["tenant-big", "tenant-held", "tenant-small"]);
    const organizationPages = queries.filter((query) => query.table === "organizations");
    expect(organizationPages.length).toBeGreaterThan(1);
    for (const page of organizationPages) {
        const asked = page.filters.find(([method, column]) => method === "in" && column === "tenant_id")?.[2] as string[];
        expect(asked.length).toBeLessThanOrEqual(100);
    }
});

it("keyset-pages the tenant list and asks work tables in bounded chunks", async () => {
    const { currentTenant } = await import("../../lib/tenantContext.js");
    const seen: (string | undefined)[] = [];
    sweeps.organizations.mockImplementation(async () => { seen.push(currentTenant()?.tenantId); return 0; });
    const many = Array.from({ length: 1205 }, (_, index) => `tenant-${String(index).padStart(4, "0")}`);
    const { db, queries } = tenantTable(
        { organizations: [many[0]!, many[1100]!, many[1204]!] },
        Object.fromEntries(many.map((id) => [id, "active"])),
    );
    await runStaleWorkSweep(db as unknown as Db, () => db as unknown as Db);
    expect(seen).toEqual([many[0], many[1100], many[1204]]);
    const tenantPages = queries.filter((query) => query.table === "tenants");
    expect(tenantPages.some((page) => page.filters.some(([method]) => method === "gt"))).toBe(true);
    const organizationPages = queries.filter((query) => query.table === "organizations");
    for (const page of organizationPages) {
        const asked = page.filters.find(([method, column]) => method === "in" && column === "tenant_id")?.[2] as string[];
        expect(asked.length).toBeLessThanOrEqual(100);
    }
});

it("runs the stale-cell sweep as each tenant with generating cells when async extraction is on", async () => {
    const { currentTenant } = await import("../../lib/tenantContext.js");
    const previous = process.env.ASYNC_TABULAR_EXTRACTION;
    process.env.ASYNC_TABULAR_EXTRACTION = "true";
    try {
        const seen: (string | undefined)[] = [];
        sweeps.cells.mockImplementation(async () => { seen.push(currentTenant()?.tenantId); return 1; });
        const { db, queries } = tenantTable(
            { tabular_cells: ["tenant-a", "tenant-b"] },
            { "tenant-a": "active", "tenant-b": "active" },
        );
        const tenantDb = { marker: "tenant" };
        await expect(runStaleWorkSweep(db as unknown as Db, () => tenantDb as unknown as Db))
            .resolves.toMatchObject({ cells: 2 });
        expect(seen).toEqual(["tenant-a", "tenant-b"]);
        expect(sweeps.cells).toHaveBeenCalledWith(tenantDb);
        expect(queries.find((query) => query.table === "tabular_cells")?.filters)
            .toContainEqual(["eq", "status", "generating"]);
    } finally {
        if (previous === undefined) delete process.env.ASYNC_TABULAR_EXTRACTION;
        else process.env.ASYNC_TABULAR_EXTRACTION = previous;
    }
});

describe("runDocumentTextBackfill (the backfill:document-text CLI)", () => {
    afterEach(() => { tenancy.mode = "single"; });

    it("single mode queues one batch with the request client, as before", async () => {
        const { currentTenant } = await import("../../lib/tenantContext.js");
        const seen: (string | undefined)[] = [];
        sweeps.text.mockImplementation(async () => { seen.push(currentTenant()?.tenantId); return 4; });
        const { db } = tenantTable({}, { "tenant-a": "active" });
        const tenantDb = { marker: "request" };
        await expect(runDocumentTextBackfill({ limit: 500, retryFailed: true },
            db as unknown as Db, () => tenantDb as unknown as Db))
            .resolves.toEqual({ queued: 4, tenants: [], failures: [] });
        expect(sweeps.text).toHaveBeenCalledTimes(1);
        expect(sweeps.text).toHaveBeenCalledWith(tenantDb, { limit: 500, retryFailed: true });
        expect(seen).toEqual([undefined]);
        expect(db.from).not.toHaveBeenCalled();
    });

    it("pooled mode runs a per-tenant batch as each sweepable tenant", async () => {
        tenancy.mode = "pooled";
        const { currentTenant } = await import("../../lib/tenantContext.js");
        const seen: (string | undefined)[] = [];
        sweeps.text.mockImplementation(async () => { seen.push(currentTenant()?.tenantId); return seen.length; });
        const { db } = tenantTable({}, {
            "tenant-a": "active", "tenant-b": "suspended", "tenant-gone": "offboarding", "tenant-new": "pending",
        });
        const tenantDb = { marker: "tenant" };
        await expect(runDocumentTextBackfill({ limit: 500, retryFailed: false },
            db as unknown as Db, () => tenantDb as unknown as Db))
            .resolves.toEqual({
                queued: 3,
                tenants: [{ tenantId: "tenant-a", queued: 1 }, { tenantId: "tenant-b", queued: 2 }],
                failures: [],
            });
        expect(seen).toEqual(["tenant-a", "tenant-b"]);
        // The limit applies per tenant; inline claims use the platform client.
        expect(sweeps.text).toHaveBeenCalledWith(tenantDb, { limit: 500, retryFailed: false, inlineDb: db });
    });

    it("pooled mode reports a tenant's failure after the other tenants ran", async () => {
        tenancy.mode = "pooled";
        const { currentTenant } = await import("../../lib/tenantContext.js");
        const boom = new Error("tenant-a down");
        sweeps.text.mockImplementation(async () => {
            if (currentTenant()?.tenantId === "tenant-a") throw boom;
            return 2;
        });
        const { db } = tenantTable({}, { "tenant-a": "active", "tenant-b": "active", "tenant-c": "active" });
        const report = await runDocumentTextBackfill({ limit: 10, retryFailed: false },
            db as unknown as Db, () => db as unknown as Db);
        expect(report.queued).toBe(4);
        expect(report.tenants.map((row) => row.tenantId)).toEqual(["tenant-b", "tenant-c"]);
        expect(report.failures).toEqual([{ tenantId: "tenant-a", error: boom }]);
    });
});
