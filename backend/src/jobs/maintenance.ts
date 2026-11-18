import { createPlatformSupabase, createServerSupabase, type Db } from "../lib/supabase";
import { safeError } from "../lib/safeError";
import { AppError, withKind } from "../lib/appError";
import { reportSchemaOutOfDateOnce } from "../lib/schemaOutOfDate";
import { runIsolated } from "../lib/dbq/jobScope";
import { reportError, setOperation } from "../lib/observability/sentry";
import type { Operation } from "../lib/observability/sentryPrivacy";
import { runWithTenant } from "../lib/tenantContext";
import { getTenancyMode } from "../lib/tenancyMode";
import { backfillDocumentText, sweepStaleProcessingDocuments } from "../modules/documents/documents.service";
import { sweepStaleGeneratingCells } from "../modules/tabular/tabular.service";
import { expireDepartureArchives, purgeExpiredOrganizations } from "../modules/orgs/orgs.service";
import { purgeExpiredSubagentRuns } from "../modules/chat/chat.service";
import { log } from "../lib/log";

/** Isolate timer-driven work just as the queue runner isolates each job. */
function runSweep<T>(operation: Operation, work: () => Promise<T>): Promise<T | undefined> {
    return runIsolated(async () => {
        setOperation(operation);
        try {
            return await work();
        } catch (cause) {
            // A database behind this build fails the same way on every sweep
            // until someone migrates it: one error-level event per operation
            // per process, then an hourly log reminder, not one event per
            // run. The other sweeps still run.
            if (reportSchemaOutOfDateOnce(cause, { key: operation, tags: { component: "stale-sweep" } })) {
                return undefined;
            }
            reportError(withKind(cause, "maintenance.sweep_failed", "Maintenance sweep failed"), {
                tags: { component: "stale-sweep" },
            });
            // Keep a content-free local notice without the error-console bridge
            // filing a second event for an already reported failure.
            log.warn("stale-sweep", "failed", { operation, ...safeError(cause) });
            return undefined;
        }
    });
}

/**
 * Tenants whose data the sweeps maintain. Suspended tenants keep their
 * deadline-driven deletions (archive expiry, organisation purge); pending
 * tenants hold no data yet, and an offboarding tenant's data belongs to its
 * purge (0194's offboarding fence refuses the writes anyway).
 */
const SWEEP_TENANT_STATUSES = ["active", "suspended"];
/** Tenant ids per work-table query, which keeps every request URL bounded. */
const TENANT_CHUNK = 100;
const PAGE = 1000;

function tenantIds(data: unknown): string[] {
    return ((data ?? []) as { tenant_id: string | null }[])
        .map((row) => row.tenant_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
}

async function sweepableTenants(db: Db): Promise<string[]> {
    const ids: string[] = [];
    let after: string | undefined;
    for (;;) {
        let query = db.from("tenants").select("tenant_id").in("status", SWEEP_TENANT_STATUSES).order("tenant_id");
        if (after !== undefined) query = query.gt("tenant_id", after);
        const { data, error } = await query.limit(PAGE);
        if (error) throw new AppError("db.query_failed", "Could not list tenants for sweep work", { cause: error });
        const page = tenantIds(data);
        ids.push(...page);
        if (page.length < PAGE) return ids;
        after = page[page.length - 1];
    }
}

/**
 * Multi-tenant divergence: sweeps that queue jobs, write tenant rows or touch
 * storage run as each affected row's tenant (the multi-tenant 008 sweep
 * pattern). The platform client only finds which sweepable tenants have
 * work; the work itself uses a tenant-claimed client, so forced RLS scopes
 * it, new rows take that tenant from the column default and storage keys get
 * its prefix.
 */
async function tenantsWithWork(
    db: Db,
    table: string,
    filter: { expiresColumn?: string; equals?: Record<string, string> } = {},
): Promise<string[]> {
    const eligible = await sweepableTenants(db);
    if (table === "tenants") return eligible;
    // PostgREST has no DISTINCT: within each chunk of eligible tenants, ask
    // again for the tenants not yet seen, so one tenant with a large backlog
    // cannot hide the others. Every round removes at least one tenant.
    const now = new Date().toISOString();
    const found: string[] = [];
    for (let start = 0; start < eligible.length; start += TENANT_CHUNK) {
        let remaining = eligible.slice(start, start + TENANT_CHUNK);
        while (remaining.length > 0) {
            let query = db.from(table).select("tenant_id").in("tenant_id", remaining);
            if (filter.expiresColumn) query = query.lte(filter.expiresColumn, now);
            for (const [column, value] of Object.entries(filter.equals ?? {})) query = query.eq(column, value);
            const { data, error } = await query.limit(PAGE);
            if (error) throw new AppError("db.query_failed", "Could not find tenants with sweep work", { cause: error });
            const hit = new Set(tenantIds(data));
            const fresh = remaining.filter((id) => hit.has(id));
            if (fresh.length === 0) break;
            found.push(...fresh);
            remaining = remaining.filter((id) => !hit.has(id));
        }
    }
    return found;
}

/** One tenant's failure is reported after the others have had their turn. */
async function forEachTenant(
    tenantIds: string[],
    tenantDb: () => Db,
    work: (db: Db) => Promise<number>,
): Promise<number> {
    let total = 0;
    let firstFailure: unknown;
    for (const tenantId of tenantIds) {
        try {
            total += await runWithTenant({ tenantId }, () => work(tenantDb()));
        } catch (cause) {
            firstFailure ??= cause;
        }
    }
    if (firstFailure !== undefined) throw firstFailure;
    return total;
}

export type DocumentTextBackfillReport = {
    queued: number;
    /** Pooled mode only: each sweepable tenant's queued count. */
    tenants: { tenantId: string; queued: number }[];
    /** Pooled mode only: tenants whose batch failed, after every other tenant ran. */
    failures: { tenantId: string; error: unknown }[];
};

/**
 * The `backfill:document-text` CLI's batch. Single mode queues as before
 * (the request client falls back to the install tenant). Multi-tenant
 * divergence: a pooled install has no install tenant, so under forced RLS a
 * claim-less call queues nothing; the batch runs as each sweepable tenant,
 * with the limit applying per tenant, as the maintenance sweep does.
 */
export async function runDocumentTextBackfill(
    options: { limit: number; retryFailed: boolean },
    db: Db = createPlatformSupabase(),
    tenantDb: () => Db = createServerSupabase,
): Promise<DocumentTextBackfillReport> {
    if (await getTenancyMode() !== "pooled") {
        return { queued: await backfillDocumentText(tenantDb(), options), tenants: [], failures: [] };
    }
    const report: DocumentTextBackfillReport = { queued: 0, tenants: [], failures: [] };
    for (const tenantId of await sweepableTenants(db)) {
        try {
            const queued = await runWithTenant({ tenantId }, () =>
                backfillDocumentText(tenantDb(), { ...options, inlineDb: db }));
            report.queued += queued;
            report.tenants.push({ tenantId, queued });
        } catch (error) {
            report.failures.push({ tenantId, error });
        }
    }
    return report;
}

/** Run recovery/expiry sweeps; errors are contained per sweep. */
export async function runStaleWorkSweep(
    db: Db = createPlatformSupabase(),
    tenantDb: () => Db = createServerSupabase,
): Promise<{ documents: number; cells: number }> {
    // Queues extraction jobs, which must carry the version's tenant.
    await runSweep("maintenance.document_text", async () =>
        forEachTenant(await tenantsWithWork(db, "tenants"), tenantDb,
            (scoped) => backfillDocumentText(scoped, { inlineDb: db })));
    const documents = await runSweep("maintenance.documents", () => sweepStaleProcessingDocuments(db));
    // Releases generation leases through finish_tabular_review_generation, a
    // tenant_definer function that sees only the claimed tenant's reviews.
    const cells = await runSweep("maintenance.cells", async () =>
        process.env.ASYNC_TABULAR_EXTRACTION === "true"
            ? forEachTenant(await tenantsWithWork(db, "tabular_cells", { equals: { status: "generating" } }), tenantDb,
                (scoped) => sweepStaleGeneratingCells(scoped))
            : sweepStaleGeneratingCells(db));
    // Writes departure events and deletes stored objects in the archive's tenant.
    await runSweep("maintenance.organization_archives", async () =>
        forEachTenant(await tenantsWithWork(db, "org_departure_archives", { expiresColumn: "expires_at" }), tenantDb,
            (scoped) => expireDepartureArchives(scoped)));
    // Writes audit rows and queues logo cleanup in the organization's tenant.
    await runSweep("maintenance.organizations", async () =>
        forEachTenant(await tenantsWithWork(db, "organizations", { expiresColumn: "purge_after" }), tenantDb,
            (scoped) => purgeExpiredOrganizations(scoped)));
    // A plain cross-tenant delete: no new rows, no storage.
    await runSweep("maintenance.subagent_runs", () => purgeExpiredSubagentRuns(db));
    return { documents: documents ?? 0, cells: cells ?? 0 };
}
