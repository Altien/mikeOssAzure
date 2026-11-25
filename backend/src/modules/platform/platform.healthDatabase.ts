// Database and queue checks for the health page. All read-only. PostgREST does
// not expose `app` or pgmigrations, so those go through the direct connection,
// each in its own read-only transaction that is rolled back. Results are counts,
// statuses and codes; no row is ever returned to the page.

import { Client } from "pg";
import { sessionUsesTls, streamRunDatabaseUri } from "../../lib/postgresSession";
import { shippedMigrations } from "../../lib/schemaCheck";
import { MissingStampConfigError, readStampConfiguration } from "../../lib/stampConfiguration";
import type { StampRuntimeMetadata } from "../../lib/stampRuntime";
import {
    createPlatformSupabase,
    createServerSupabase,
    PLATFORM_DB_ROLE,
    postgrestClaims,
    tenantDbRole,
    usesSignedPostgrest,
} from "../../lib/supabase";
import { getTenancyMode } from "../../lib/tenancyMode";
import { installTenantId, runWithTenant } from "../../lib/tenantContext";
import {
    checkTenantPostgrestPath,
    databaseErrorCode,
    isPermissionDenied,
    roleMissingGuidance,
    STREAM_RUN_LOGIN,
    tableGrantGuidance,
    TENANT_PROBE_ID,
    tenantPathGuidance,
    tenantProbeContext,
    tenantRoleGuidance,
} from "../../lib/tenantDatabaseProbe";
import { codedFailure, errorSummary, type CheckOutcome, type HealthCheck } from "./platform.shared";

const SESSION_TIMEOUT_MS = 8_000;
const STALE_QUEUE_MINUTES = 15;
const MINUTE_MS = 60_000;
const ASSIGNED_TABLES = ["projects", "documents", "user_profiles"] as const;
const UNDEFINED_TABLE = "42P01";
const ROLE_SWITCH_INVALID = "22023";

const NOT_CONFIGURED: CheckOutcome = {
    status: "skip",
    detail: "No direct database connection is configured (STREAM_RUN_DATABASE_URL / pgrst-db-uri).",
};

async function directDatabaseUri(): Promise<string | null> {
    try {
        return await streamRunDatabaseUri();
    } catch (error) {
        const absent = (error as { statusCode?: number }).statusCode === 404
            || (error as Error).message === "Stream run database URI unavailable";
        if (absent) return null;
        throw error;
    }
}

/** A short-lived connection in a read-only transaction, closed on timeout. Null if not configured. */
export async function withReadOnlySession<T>(
    signal: AbortSignal,
    work: (client: Client) => Promise<T>,
): Promise<{ value: T } | null> {
    const uri = await directDatabaseUri();
    if (!uri) return null;
    return { value: await sessionAt(uri, signal, work) };
}

async function sessionAt<T>(uri: string, signal: AbortSignal, work: (client: Client) => Promise<T>): Promise<T> {
    // The URI read has no signal. A check that timed out during it must not then connect.
    if (signal.aborted) throw new Error("Timed out");
    const client = new Client({
        connectionString: uri,
        ssl: sessionUsesTls(uri) ? { rejectUnauthorized: true } : false,
        connectionTimeoutMillis: SESSION_TIMEOUT_MS,
        query_timeout: SESSION_TIMEOUT_MS,
        statement_timeout: SESSION_TIMEOUT_MS,
    });
    client.on("error", () => {});
    const close = () => { void client.end().catch(() => {}); };
    signal.addEventListener("abort", close, { once: true });
    try {
        await client.connect();
        await client.query("begin read only");
        const value = await work(client);
        await client.query("rollback");
        return value;
    } finally {
        signal.removeEventListener("abort", close);
        await client.end().catch(() => {});
    }
}

async function runtimeMetadata(signal: AbortSignal): Promise<StampRuntimeMetadata> {
    const { data, error, status } = await createPlatformSupabase().rpc("stamp_runtime_metadata").abortSignal(signal);
    if (error || !data) throw codedFailure(error, status);
    return data as StampRuntimeMetadata;
}

async function signedPostgrest(signal: AbortSignal): Promise<CheckOutcome> {
    if (!usesSignedPostgrest()) return { status: "skip", detail: "Hosted Supabase does not use signed PostgREST requests." };
    try {
        await runtimeMetadata(signal);
        return { status: "pass", detail: "PostgREST accepted a signed service_role request." };
    } catch (error) {
        return {
            status: "fail",
            detail: `A signed service_role request failed (${errorSummary(error)}).`,
            remediation: "Check that the PostgREST app is running and that its PGRST_JWT_SECRET is the same value as Key Vault postgrest-jwt-secret. PostgREST takes a changed value only in a new PostgREST revision.",
        };
    }
}

async function unsignedRejected(signal: AbortSignal): Promise<CheckOutcome> {
    if (!usesSignedPostgrest()) return { status: "skip", detail: "Hosted Supabase does not use signed PostgREST requests." };
    const entra = (process.env.AUTH_PROVIDER ?? "").toLowerCase() === "entra";
    const response = await fetch(`${process.env.SUPABASE_URL}/tenants?select=tenant_id&limit=1`, { signal });
    await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) {
        return { status: "pass", detail: `An unsigned request was refused (HTTP ${response.status}).` };
    }
    return {
        status: entra && response.ok ? "fail" : "warn",
        detail: `An unsigned request got HTTP ${response.status}, not a refusal.`,
        remediation: entra
            ? "Remove PGRST_DB_ANON_ROLE from the PostgREST app and make sure PGRST_JWT_SECRET is set, so that a request without a JWT is rejected."
            : "Check that PostgREST's anonymous role (web_anon) has no access to tenant tables.",
    };
}

async function tenantRole(signal: AbortSignal): Promise<CheckOutcome> {
    const result = await checkTenantPostgrestPath(signal);
    if (result.state === "skipped") return { status: "skip", detail: "Hosted Supabase does not use signed PostgREST requests." };
    if (result.state === "ok") return { status: "pass", detail: `Tenant traffic can read as role ${result.role}.` };
    const http = result.httpStatus ? `, HTTP ${result.httpStatus}` : "";
    return {
        status: "fail",
        detail: `A read as role ${result.role} failed (code ${result.code}${http}).`,
        remediation: await tenantPathGuidance(result.role, result.code),
    };
}

async function tenantsCount(signal: AbortSignal, scope?: string): Promise<number> {
    const query = async () => {
        const client = scope ? createServerSupabase() : createPlatformSupabase();
        return await client.from("tenants").select("tenant_id", { count: "exact", head: true }).abortSignal(signal);
    };
    const { count, error, status } = scope ? await runWithTenant({ tenantId: scope }, query) : await query();
    if (error) throw codedFailure(error, status);
    return count ?? 0;
}

/** The authoritative answer, or null when the direct session cannot give one. */
async function roleBypassAttribute(signal: AbortSignal): Promise<boolean | null | "no role"> {
    try {
        const session = await withReadOnlySession(signal, async (client) => {
            const { rows } = await client.query<{ rolbypassrls: boolean }>(
                "select rolbypassrls from pg_roles where rolname = $1", [PLATFORM_DB_ROLE],
            );
            return rows[0] ? rows[0].rolbypassrls === true : "no role" as const;
        });
        return session ? session.value : null;
    } catch {
        return null;
    }
}

// A function, because route tests mock the supabase module and this file loads with buildApp().
const grantBypass = () => `Run ALTER ROLE ${PLATFORM_DB_ROLE} BYPASSRLS as the server administrator.`;

/**
 * pg_roles decides when the direct session is available. Otherwise only counts
 * remain: rows visible to service_role with no tenant claim show it bypasses
 * RLS, but seeing none proves nothing, because an empty table looks the same.
 */
async function serviceRoleBypass(signal: AbortSignal): Promise<CheckOutcome> {
    if (!usesSignedPostgrest()) return { status: "skip", detail: "Hosted Supabase has one client for both scopes." };
    const attribute = await roleBypassAttribute(signal);
    if (attribute === true) return { status: "pass", detail: `pg_roles shows ${PLATFORM_DB_ROLE} has BYPASSRLS.` };
    if (attribute === false) {
        return {
            status: "fail",
            detail: `pg_roles shows ${PLATFORM_DB_ROLE} does not have BYPASSRLS.`,
            remediation: grantBypass(),
        };
    }
    if (attribute === "no role") {
        return {
            status: "fail",
            detail: `Role ${PLATFORM_DB_ROLE} does not exist in this database.`,
            remediation: "Run the migration job, or create the role as the server administrator.",
        };
    }
    const install = await installTenantId().catch(() => undefined);
    const [platform, asInstall] = await Promise.all([
        tenantsCount(signal),
        install ? tenantsCount(signal, install) : Promise.resolve(0),
    ]);
    if (platform < asInstall) {
        return {
            status: "fail",
            detail: `service_role sees ${platform} tenant rows but the install tenant sees ${asInstall}, so it is subject to RLS.`,
            remediation: grantBypass(),
        };
    }
    if (platform === 0) {
        return { status: "info", detail: "Could not be proven: no direct session to read pg_roles, and service_role sees no tenant rows, which an empty table would also show." };
    }
    const asNobody = await tenantsCount(signal, TENANT_PROBE_ID);
    if (asNobody >= platform && (await tenantDbRole()) !== PLATFORM_DB_ROLE) {
        return {
            status: "fail",
            detail: `A claim for no tenant sees ${asNobody} of ${platform} tenant rows, so RLS is not filtering.`,
            remediation: "Run backend migrations, then check app.tenant_rls_gaps() as service_role.",
        };
    }
    return { status: "pass", detail: `service_role sees ${platform} tenant rows; a claim for no tenant sees ${asNobody}.` };
}

/** The configured tenant of a single install, or the outcome naming what is missing. */
async function configuredInstallTenant(): Promise<{ tenantId: string } | { outcome: CheckOutcome }> {
    try {
        const { fallbackTenantId } = await readStampConfiguration();
        if (fallbackTenantId) return { tenantId: fallbackTenantId };
        return { outcome: missingTenantSetting("entra-tenant-id") };
    } catch (error) {
        if (error instanceof MissingStampConfigError) return { outcome: missingTenantSetting(error.setting) };
        throw error;
    }
}

function missingTenantSetting(setting: string): CheckOutcome {
    return {
        status: "fail",
        detail: `The install tenant cannot be read because ${setting} has no value.`,
        remediation: `Set ${setting} in Key Vault to the tenant this install serves, then reload this page.`,
    };
}

async function installTenant(signal: AbortSignal): Promise<CheckOutcome> {
    if (await getTenancyMode() === "pooled") return { status: "skip", detail: "A pooled stamp has no install tenant." };
    const tenant = await configuredInstallTenant();
    if ("outcome" in tenant) return tenant.outcome;
    const configured = tenant.tenantId;
    const metadata = await runtimeMetadata(signal);
    if (metadata.fallback_tenant_id !== null && metadata.fallback_tenant_id !== configured) {
        return {
            status: "fail",
            detail: "The database's fallback tenant differs from the configured tenant.",
            remediation: "Follow \"Install tenant check\" in docs/operator-checks.md to decide which value is correct.",
        };
    }
    const { data, error, status } = await createPlatformSupabase()
        .from("tenants").select("status").eq("tenant_id", configured).abortSignal(signal).maybeSingle();
    if (error) throw codedFailure(error, status);
    const fallback = metadata.fallback_tenant_id === null
        ? "The database has no fallback tenant yet."
        : "The database's fallback tenant matches the configured tenant.";
    if (!data) {
        return {
            status: "warn",
            detail: `${fallback} The install tenant has no row in tenants.`,
            remediation: "Onboard the tenant: sign-in is refused until it exists. tenant-onboarding-mode=auto creates it at startup.",
        };
    }
    const rowStatus = typeof data.status === "string" && /^[a-z_]{1,30}$/.test(data.status) ? data.status : "unknown";
    if (rowStatus !== "active") {
        return {
            status: "fail",
            detail: `${fallback} The install tenant's status is ${rowStatus}.`,
            remediation: "Set this tenant's status to active in public.tenants, if it was not suspended on purpose.",
        };
    }
    return { status: "pass", detail: `${fallback} The install tenant is active.` };
}

async function dataAssignment(signal: AbortSignal): Promise<CheckOutcome> {
    if (await getTenancyMode() === "pooled") return { status: "skip", detail: "A pooled stamp holds many tenants' data." };
    const tenant = await configuredInstallTenant();
    if ("outcome" in tenant) return tenant.outcome;
    const counts = await Promise.all(ASSIGNED_TABLES.map(async (table) => {
        const { count, error, status } = await createPlatformSupabase()
            .from(table).select("tenant_id", { count: "exact", head: true })
            .neq("tenant_id", tenant.tenantId).abortSignal(signal);
        if (error) throw codedFailure(error, status);
        return { table, count: count ?? 0 };
    }));
    const summary = counts.map(({ table, count }) => `${table} ${count}`).join(", ");
    if (counts.every(({ count }) => count === 0)) {
        return { status: "pass", detail: `Rows under another tenant: ${summary}.` };
    }
    return {
        status: "fail",
        detail: `Rows under another tenant: ${summary}. Users cannot see these rows.`,
        remediation: "Find which tenant holds them with a query as the server administrator, then follow \"Install tenant check\" in docs/operator-checks.md before changing them.",
    };
}

function migrationHistoryAdvice(code: string, roleSwitched: boolean): string {
    if (isPermissionDenied(code)) {
        return roleSwitched
            ? tableGrantGuidance(PLATFORM_DB_ROLE, "public.pgmigrations")
            : `The stream-run login needs the ${PLATFORM_DB_ROLE} role. As the server administrator, run: GRANT ${PLATFORM_DB_ROLE} TO <login>.`;
    }
    if (code === UNDEFINED_TABLE) {
        return "This database has no migration history. Check that the connection names the right database, and run the migration job.";
    }
    return "Check that the database is running and reachable from the backend, and the connection setting STREAM_RUN_DATABASE_URL / pgrst-db-uri. The Stream-run login result below separates these.";
}

/** As service_role: the login need not be the one that ran the migrations. */
async function migrations(signal: AbortSignal): Promise<CheckOutcome> {
    const shipped = shippedMigrations();
    let session: { value: string[] } | null;
    const progress = { roleSwitched: false };
    try {
        session = await withReadOnlySession(signal, async (client) => {
            await client.query(`set local role ${PLATFORM_DB_ROLE}`);
            progress.roleSwitched = true;
            const { rows } = await client.query<{ name: string }>("select name from public.pgmigrations");
            return rows.map((row) => row.name);
        });
    } catch (error) {
        return {
            status: "warn",
            detail: `Could not read the migration history (${errorSummary(error)}).`,
            remediation: migrationHistoryAdvice(databaseErrorCode(error), progress.roleSwitched),
        };
    }
    if (!session) return NOT_CONFIGURED;
    const applied = session.value;
    const latestApplied = [...applied].sort().at(-1) ?? "none";
    if (!shipped.length) return { status: "info", detail: `Latest applied: ${latestApplied}. This build has no migrations directory to compare with.` };
    const appliedNames = new Set(applied);
    const pending = shipped.filter((name) => !appliedNames.has(name));
    const summary = `Latest applied: ${latestApplied}. Latest shipped: ${shipped.at(-1)}.`;
    if (pending.length) {
        return {
            status: "fail",
            detail: `${summary} ${pending.length} not applied.`,
            remediation: "Run the migration job with the same image as this backend, or re-run the upgrade script.",
        };
    }
    if (latestApplied > (shipped.at(-1) ?? "")) {
        return {
            status: "warn",
            detail: `${summary} The database is ahead of this build.`,
            remediation: "Check that this revision uses the image the migration job ran from.",
        };
    }
    return { status: "pass", detail: summary };
}

async function rlsGaps(signal: AbortSignal): Promise<CheckOutcome> {
    let session: { value: number } | null;
    try {
        session = await withReadOnlySession(signal, async (client) => {
            // Executable by service_role only (0180).
            await client.query(`set local role ${PLATFORM_DB_ROLE}`);
            const { rows } = await client.query<{ gaps: number }>("select count(*)::int as gaps from app.tenant_rls_gaps()");
            return rows[0]?.gaps ?? 0;
        });
    } catch (error) {
        return {
            status: "warn",
            detail: `Could not run the gate (${errorSummary(error)}).`,
            remediation: "Check the Stream-run login result below, and that migrations are current.",
        };
    }
    if (!session) return NOT_CONFIGURED;
    if (session.value === 0) return { status: "pass", detail: "No gaps." };
    return {
        status: "fail",
        detail: `${session.value} gaps.`,
        remediation: "As the server administrator, run: set role service_role; select object, problem from app.tenant_rls_gaps(); Then contact support with the result.",
    };
}

async function streamLogin(signal: AbortSignal): Promise<CheckOutcome> {
    const role = await tenantDbRole();
    const scope = await tenantProbeContext();
    const claims = JSON.stringify(postgrestClaims(scope, role));

    let uri: string | null;
    try {
        uri = await directDatabaseUri();
    } catch (error) {
        return {
            status: "fail",
            detail: `Could not read the connection setting (${errorSummary(error)}).`,
            remediation: "Check the Key Vault result above, and that STREAM_RUN_DATABASE_URL / pgrst-db-uri holds a valid PostgreSQL URI.",
        };
    }
    if (!uri) return NOT_CONFIGURED;

    // Which step failed decides the advice: only a refused role switch is about the login.
    const progress: { step: "connect" | "role-switch" | "table-read"; role: string } = { step: "connect", role };
    try {
        await sessionAt(uri, signal, async (client) => {
            progress.step = "role-switch";
            progress.role = PLATFORM_DB_ROLE;
            await client.query(`set local role ${PLATFORM_DB_ROLE}`);
            await client.query("reset role");
            progress.role = role;
            await client.query(`set local role ${role}`);
            await client.query("select set_config('request.jwt.claims', $1, true)", [claims]);
            progress.step = "table-read";
            await client.query("select id from public.stream_runs limit 1");
        });
    } catch (error) {
        const summary = errorSummary(error);
        const code = databaseErrorCode(error);
        if (progress.step === "connect") {
            return {
                status: "fail",
                detail: `Could not connect with the stream-run login (${summary}).`,
                remediation: "Check that the database is running and reachable from the backend, and the host, login, password and TLS settings in STREAM_RUN_DATABASE_URL / pgrst-db-uri.",
            };
        }
        if (progress.step === "table-read" && isPermissionDenied(code)) {
            return {
                status: "fail",
                detail: `Role ${progress.role} could not read public.stream_runs (${summary}). The login can use the role.`,
                remediation: tableGrantGuidance(progress.role, "public.stream_runs"),
            };
        }
        if (isPermissionDenied(code)) {
            return {
                status: "fail",
                detail: `The stream-run login could not use role ${progress.role} (${summary}).`,
                remediation: await tenantRoleGuidance(progress.role, STREAM_RUN_LOGIN),
            };
        }
        if (progress.step === "role-switch" && code === ROLE_SWITCH_INVALID) {
            return {
                status: "fail",
                detail: `The stream-run login could not switch to role ${progress.role} (${summary}).`,
                remediation: roleMissingGuidance(progress.role),
            };
        }
        return {
            status: "fail",
            detail: `The stream-run connection failed while checking role ${progress.role} (${summary}).`,
            remediation: "Check that the database is running and that migrations are current, then reload this page.",
        };
    }
    return { status: "pass", detail: `The login can use ${PLATFORM_DB_ROLE} and ${role}.` };
}

function minutesSince(iso: unknown, now: number): number | null {
    const at = typeof iso === "string" ? Date.parse(iso) : Number.NaN;
    return Number.isNaN(at) ? null : Math.max(0, Math.floor((now - at) / MINUTE_MS));
}

async function queueState(signal: AbortSignal): Promise<CheckOutcome> {
    const now = Date.now();
    const db = createPlatformSupabase();
    const jobCount = async (status: string, since?: string) => {
        let query = db.from("db_jobs").select("id", { count: "exact", head: true }).eq("status", status);
        if (since) query = query.gte("finished_at", since);
        const result = await query.abortSignal(signal);
        if (result.error) throw codedFailure(result.error, result.status);
        return result.count ?? 0;
    };
    const [queued, failed, oldest] = await Promise.all([
        jobCount("pending"),
        jobCount("failed", new Date(now - 24 * 60 * MINUTE_MS).toISOString()),
        db.from("db_jobs").select("run_at").eq("status", "pending").lte("run_at", new Date(now).toISOString())
            .order("run_at", { ascending: true }).limit(1).abortSignal(signal),
    ]);
    if (oldest.error) throw codedFailure(oldest.error, oldest.status);
    const age = minutesSince(oldest.data?.[0]?.run_at, now);
    const summary = `${queued} queued, oldest due job ${age === null ? "none" : `${age} min`}, ${failed} failed in the last 24 hours.`;
    if (age !== null && age > STALE_QUEUE_MINUTES) {
        return {
            status: "warn",
            detail: summary,
            remediation: "Check that the worker app has a running replica, and read its console logs: jobs are not being claimed.",
        };
    }
    return { status: "pass", detail: summary };
}

/** There is no worker heartbeat row in this codebase; the latest job claim is the nearest evidence. */
async function workerActivity(signal: AbortSignal): Promise<CheckOutcome> {
    const { data, error, status } = await createPlatformSupabase()
        .from("db_jobs").select("claimed_at").not("claimed_at", "is", null)
        .order("claimed_at", { ascending: false }).limit(1).abortSignal(signal);
    if (error) throw codedFailure(error, status);
    const age = minutesSince(data?.[0]?.claimed_at, Date.now());
    const claim = age === null ? "No job has been claimed yet." : `Latest job claim ${age} min ago.`;
    return { status: "info", detail: `Workers record no heartbeat. ${claim}` };
}

export function databaseChecks(): HealthCheck[] {
    const group = "Database";
    return [
        { id: "db.postgrest-signed", group, title: "PostgREST reachable with signing", run: signedPostgrest },
        { id: "db.unsigned-rejected", group, title: "Unsigned request rejected", run: unsignedRejected },
        { id: "db.tenant-role", group, title: "Tenant role switch", run: tenantRole },
        { id: "db.service-role-bypass", group, title: "service_role bypasses RLS", run: serviceRoleBypass },
        { id: "db.install-tenant", group, title: "Install tenant", run: installTenant },
        { id: "db.data-assignment", group, title: "Data assigned to the install tenant", run: dataAssignment },
        { id: "db.migrations", group, title: "Migrations applied", run: migrations },
        { id: "db.rls-gaps", group, title: "app.tenant_rls_gaps()", run: rlsGaps },
        { id: "db.stream-login", group, title: "Stream-run login", run: streamLogin },
    ];
}

export function workerChecks(): HealthCheck[] {
    const group = "Worker";
    return [
        { id: "worker.queue", group, title: "Job queue", run: queueState },
        { id: "worker.activity", group, title: "Worker activity", run: workerActivity },
    ];
}
