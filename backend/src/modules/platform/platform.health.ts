// The health page's checks (POST /diag). Read-only, and it
// must work when sign-in does not, so it uses no session.
//
// Every check gets its own timeout and failure isolation, so the page always
// renders. A check's raw error never reaches the output: the runner reports only
// a code and status, and scrubs every line as a last defence.

import { probeKeyVault } from "../../lib/config";
import { isConclusiveAbsence, isFormatFailure, manifestItemsInSection } from "../../lib/install/manifest";
import type { CheckResult } from "../../lib/install/types";
import { isSentryEnabled } from "../../lib/observability/sentry";
import { redactSensitiveText } from "../../lib/safeError";
import { optionalStampConfig } from "../../lib/stampConfiguration";
import { listFiles, storageEnabled } from "../../lib/storage";
import { tenantDbRole } from "../../lib/supabase";
import { getTenancyMode } from "../../lib/tenancyMode";
import { runWithTenant } from "../../lib/tenantContext";
import { tenantProbeContext } from "../../lib/tenantDatabaseProbe";
import { entraChecks } from "./platform.healthEntra";
import { databaseChecks, workerChecks } from "./platform.healthDatabase";
import { configPickup, errorSummary, type CheckOutcome, type HealthCheck, type HealthResult } from "./platform.shared";

const CHECK_TIMEOUT_MS = 10_000;
const DEFAULT_REMEDIATION = "Read the backend's console logs from the same time, then reload this page.";

const ENTRA_SECRETS = [
    "entra-tenant-id", "entra-client-id", "entra-client-secret", "entra-backend-client-id",
    "postgrest-jwt-secret", "backend-public-url",
    "auth-session-encryption-secret", "auth-handoff-encryption-secret", "auth-state-secret",
];
const POOLED_SECRETS = [
    "altien-entra-tenant-id", "altien-entra-client-id", "altien-entra-client-secret", "altien-entra-backend-client-id",
    "entra-client-id", "entra-client-secret", "entra-backend-client-id",
    "postgrest-jwt-secret", "backend-public-url", "frontend-url", "word-addin-url", "pooled-onboarding-url",
    "stamp-id", "stamp-region",
];
const LOCAL_SECRETS = ["jwt-secret", "supabase-url"];
const SUPABASE_SECRETS = ["supabase-url", "supabase-secret-key"];
/**
 * The config cache cannot deliver these. initServerSessionKeys loads the auth-*
 * keys before listen and holds them; runtime reads the others from process.env,
 * never getConfig, so this check can find a Key Vault value runtime does not have.
 */
const REVISION_REQUIRED_SECRETS = new Set([
    "auth-session-encryption-secret", "auth-handoff-encryption-secret", "auth-state-secret",
    "jwt-secret", "supabase-secret-key", "supabase-url",
]);

/** One line, and no credential-shaped text even if a check let one through. */
function scrub(text: string): string {
    return redactSensitiveText(text)
        .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/]*:[^\s/]*@\S*/gi, "[redacted]")
        .replace(/\s+/g, " ")
        .trim();
}

async function runOne(check: HealthCheck, timeoutMs: number): Promise<HealthResult> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<CheckOutcome>((resolve) => {
        timer = setTimeout(() => {
            controller.abort();
            resolve({
                status: "fail",
                detail: `Did not finish within ${Math.round(timeoutMs / 1000)} s.`,
                remediation: "Check that the service this check calls is running and reachable from the backend.",
            });
        }, timeoutMs);
    });
    let outcome: CheckOutcome;
    try {
        const running = Promise.resolve().then(() => check.run(controller.signal));
        outcome = await Promise.race([running, timedOut]);
    } catch (error) {
        outcome = { status: "fail", detail: `The check could not complete (${errorSummary(error)}).` };
    } finally {
        clearTimeout(timer);
    }
    const remediation = outcome.remediation
        ?? (outcome.status === "warn" || outcome.status === "fail" ? DEFAULT_REMEDIATION : undefined);
    return {
        id: check.id,
        group: check.group,
        title: check.title,
        status: outcome.status,
        detail: scrub(outcome.detail),
        ...(remediation ? { remediation: scrub(remediation) } : {}),
    };
}

/** Run checks concurrently; one that fails or hangs cannot affect the others. */
export async function runChecks(checks: HealthCheck[], timeoutMs = CHECK_TIMEOUT_MS): Promise<HealthResult[]> {
    return Promise.all(checks.map((check) => runOne(check, timeoutMs)));
}

function info(detail: string): CheckOutcome {
    return { status: "info", detail };
}

function authProvider(): string {
    return (process.env.AUTH_PROVIDER ?? "supabase").toLowerCase();
}

async function requiredSecrets(): Promise<CheckOutcome> {
    const provider = authProvider();
    const names = await getTenancyMode() === "pooled"
        ? POOLED_SECRETS
        : provider === "entra" ? ENTRA_SECRETS : provider === "local" ? LOCAL_SECRETS : SUPABASE_SECRETS;
    const found = await Promise.all(names.map(async (name) => {
        // As probeStampRuntime: API_PUBLIC_URL stands in for backend-public-url.
        if (name === "backend-public-url" && process.env.API_PUBLIC_URL) return { name, state: "present" };
        try {
            return { name, state: await optionalStampConfig(name) ? "present" : "missing" };
        } catch {
            return { name, state: "unreadable" };
        }
    }));
    const missing = found.filter((item) => item.state === "missing").map((item) => item.name);
    const unreadable = found.filter((item) => item.state === "unreadable").map((item) => item.name);
    if (!missing.length && !unreadable.length) return { status: "pass", detail: `All ${names.length} present: ${names.join(", ")}.` };
    const parts = [
        ...(missing.length ? [`Missing: ${missing.join(", ")}.`] : []),
        ...(unreadable.length ? [`Could not read: ${unreadable.join(", ")}.`] : []),
    ];
    return {
        status: "fail",
        detail: parts.join(" "),
        remediation: unreadable.length
            ? "Check the Key Vault result above; the backend's managed identity needs secret read access."
            : setMissingRemedy(missing),
    };
}

function setMissingRemedy(missing: string[]): string {
    const sentences: string[] = [];
    const cached = missing.filter((name) => !REVISION_REQUIRED_SECRETS.has(name));
    if (cached.length) {
        const names = cached.join(", ");
        const pickedUp = configPickup(cached);
        sentences.push(`Set ${names} in Key Vault, ${pickedUp}.`);
    }
    const revisionRequired = missing.filter((name) => REVISION_REQUIRED_SECRETS.has(name));
    if (revisionRequired.length) {
        const names = revisionRequired.join(", ");
        sentences.push(`Set ${names}, then create a new backend revision: the backend takes these only when a revision starts, either loading them once or from its environment, where a Key Vault value arrives through a secret reference.`);
    }
    if (missing.includes("postgrest-jwt-secret")) {
        sentences.push("postgrest-jwt-secret also needs a new PostgREST revision, because PostgREST holds its copy, PGRST_JWT_SECRET, from its own revision start, and the two sides must match.");
    }
    return sentences.join(" ");
}

async function telemetry(): Promise<CheckOutcome> {
    const insights = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING ? "on" : "off";
    const sentry = isSentryEnabled() ? "on" : "off";
    return info(`Application Insights ${insights}. Sentry ${sentry}.`);
}

async function tenantRlsEnforced(): Promise<CheckOutcome> {
    const role = await tenantDbRole();
    if (role === "tenant_app") return { status: "pass", detail: "Enforced: tenant requests run as tenant_app." };
    return {
        status: "warn",
        detail: `Rolled back: tenant requests run as ${role}, without the database enforcing the tenant boundary.`,
        remediation: "Fix the cause, then remove tenant-rls-enforced=false from Key Vault.",
    };
}

async function keyVault(): Promise<CheckOutcome> {
    if (!process.env.KEY_VAULT_NAME) return { status: "skip", detail: "KEY_VAULT_NAME is not set." };
    try {
        await probeKeyVault();
        return { status: "pass", detail: "Key Vault answered this identity." };
    } catch (error) {
        return {
            status: "fail",
            detail: `Key Vault could not be read (${errorSummary(error)}).`,
            remediation: "Check the vault's network access and that the backend's managed identity (AZURE_CLIENT_ID) has secret read access.",
        };
    }
}

function configurationChecks(): HealthCheck[] {
    const group = "Configuration";
    const sha = process.env.GIT_SHA?.trim();
    return [
        { id: "config.version", group, title: "Version", run: async () => info(sha ? `Git SHA ${sha.slice(0, 12)}.` : "No git SHA recorded in this build.") },
        { id: "config.auth-provider", group, title: "Auth provider", run: async () => info(authProvider()) },
        { id: "config.tenancy-mode", group, title: "Tenancy mode", run: async () => info(await getTenancyMode()) },
        { id: "config.tenant-rls", group, title: "tenant-rls-enforced", run: tenantRlsEnforced },
        { id: "config.telemetry", group, title: "Telemetry", run: telemetry },
        { id: "config.node-env", group, title: "NODE_ENV", run: async () => info(process.env.NODE_ENV || "not set") },
        { id: "config.key-vault", group, title: "Key Vault reachable", run: keyVault },
        { id: "config.required-secrets", group, title: "Required secrets (names only)", run: requiredSecrets },
    ];
}

async function storageConfigured(): Promise<CheckOutcome> {
    if (storageEnabled) return { status: "pass", detail: "Storage is configured." };
    return {
        status: "fail",
        detail: "Storage is not configured.",
        remediation: "Set the storage account and container for this deployment, then create a new backend revision.",
    };
}

async function storageReachable(): Promise<CheckOutcome> {
    if (!storageEnabled) return { status: "skip", detail: "Storage is not configured." };
    try {
        // A prefix nothing uses: this reads a listing and no object.
        const scope = await tenantProbeContext();
        await runWithTenant(scope, () => listFiles("mike-diagnostics-probe/"));
        return { status: "pass", detail: "The container answered a list request." };
    } catch (error) {
        return {
            status: "fail",
            detail: `The container could not be listed (${errorSummary(error)}).`,
            remediation: "Check that the container exists, the storage account's network access, and the managed identity's Storage Blob Data role.",
        };
    }
}

function storageChecks(): HealthCheck[] {
    const group = "Storage";
    return [
        { id: "storage.configured", group, title: "Storage configured", run: storageConfigured },
        { id: "storage.reachable", group, title: "Container reachable", run: storageReachable },
    ];
}

/** Legal research, in the same /install section, but it cannot answer a chat. */
const NON_LLM_PROVIDER_ITEMS = new Set(["ai-courtlistener-token"]);

type ProviderState = "configured" | "invalid" | "absent" | "unknown";

const PROVIDER_STATE_TEXT: Record<ProviderState, string> = {
    configured: "configured",
    invalid: "present but invalid",
    absent: "not configured",
    unknown: "unknown",
};

function providerState(result: CheckResult | null): ProviderState {
    if (result?.status === "pass") return "configured";
    if (result && isFormatFailure(result)) return "invalid";
    if (result && isConclusiveAbsence(result)) return "absent";
    // With no vault there is nothing to be out: the setting just is not there.
    return process.env.KEY_VAULT_NAME ? "unknown" : "absent";
}

/** Whether /install would show each provider as set. Its details hold values, so only their kind is used. */
async function providers(): Promise<CheckOutcome> {
    const context = { backendFqdn: "", keyVaultName: "", resourceGroup: "" };
    const states = await Promise.all(manifestItemsInSection("AI providers").map(async (item) => {
        const result = await item.check(context).catch(() => null);
        return { id: item.id, label: item.label, state: providerState(result) };
    }));
    const llm = states.filter((state) => !NON_LLM_PROVIDER_ITEMS.has(state.id));
    const labels = (state: ProviderState) => llm.filter((item) => item.state === state).map((item) => item.label);
    const other = states
        .filter((state) => NON_LLM_PROVIDER_ITEMS.has(state.id))
        .map((state) => {
            const text = PROVIDER_STATE_TEXT[state.state];
            return `${state.label} ${text}`;
        });
    const on = labels("configured");
    const unknown = labels("unknown");
    const invalid = labels("invalid");
    const parts = [
        `Configured: ${on.join(", ") || "none"}.`,
        `Not configured: ${labels("absent").join(", ") || "none"}.`,
        ...(invalid.length ? [`Present but invalid format: ${invalid.join(", ")}.`] : []),
        ...(unknown.length ? [`Unknown, could not be read: ${unknown.join(", ")}.`] : []),
        ...(other.length ? [`Not an LLM provider: ${other.join(", ")}.`] : []),
    ];
    const detail = parts.join(" ");
    if (unknown.length) {
        return {
            status: "warn",
            detail,
            remediation: "Check the Key Vault result above, then reload this page: these credentials may be set.",
        };
    }
    if (invalid.length) {
        return {
            status: "warn",
            detail,
            remediation: "Replace those values on /install or in Key Vault: each is set, but not in the form that provider issues.",
        };
    }
    if (on.length) return { status: "pass", detail };
    return {
        status: "warn",
        detail,
        remediation: "Add at least one LLM provider's credential on /install or in Key Vault.",
    };
}

function allChecks(requestHost: string): HealthCheck[] {
    return [
        ...configurationChecks(),
        ...entraChecks(requestHost),
        ...databaseChecks(),
        ...storageChecks(),
        ...workerChecks(),
        { id: "providers.credentials", group: "Providers", title: "LLM provider credentials (no live calls)", run: providers },
    ];
}

let inFlight: Promise<HealthResult[]> | null = null;

/**
 * The whole page. Never rejects, because every check is isolated. Concurrent
 * requests share one run, so reloading cannot multiply the database sessions;
 * nothing is cached once it ends. Calls with no signal of their own (Key Vault,
 * the storage listing, the managed identity token) are left to finish after a
 * check times out.
 */
export function runHealthChecks(args: { requestHost: string }): Promise<HealthResult[]> {
    if (inFlight) return inFlight;
    const run: Promise<HealthResult[]> = runChecks(allChecks(args.requestHost)).finally(() => {
        // Only its own: a reset in tests may already have let a later run start.
        if (inFlight === run) inFlight = null;
    });
    inFlight = run;
    return run;
}

/** Test seam, like resetFrozenTenancyModeForTests: a run from one test is not joined by the next. */
export function resetHealthRunForTests(): void {
    inFlight = null;
}
