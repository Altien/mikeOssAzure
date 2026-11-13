// Entra checks for the health page. They exist for the outage that /api/health
// and the logs do not show: an expired client secret, which breaks all sign-in.
//
// The token request's response is never parsed on success, so the token is not
// held at all. On failure only the numeric AADSTS code is kept, because Entra's
// description carries app and correlation identifiers.

import { entraOAuthConfiguration } from "../../lib/auth/entraConfiguration";
import { getConfig } from "../../lib/config";
import { checkRedirectUris, GRAPH_BASE, GRAPH_SCOPE, mintGraphToken } from "../../lib/install/checks/redirectUris";
import { optionalStampConfig } from "../../lib/stampConfiguration";
import { getTenancyMode } from "../../lib/tenancyMode";
import { configPickup, type CheckOutcome, type HealthCheck } from "./platform.shared";

const WARN_WITHIN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type GraphCredential = { displayName?: unknown; hint?: unknown; endDateTime?: unknown };

const SINGLE_SETTINGS = ["entra-tenant-id", "entra-client-id", "entra-backend-client-id", "entra-client-secret"];
const POOLED_SETTINGS = [
    "altien-entra-tenant-id", "altien-entra-authority", "altien-entra-issuer", "altien-entra-jwks-uri",
    "altien-entra-client-id", "altien-entra-backend-client-id", "altien-entra-client-secret",
];

function replaceSecretRemedy(secretName: string): string {
    const pickedUp = configPickup([secretName]);
    return `Create a new client secret on the app registration and write it as a new version of Key Vault ${secretName}, ${pickedUp}. Do not re-run create-entra-apps.ps1.`;
}

/**
 * The settings this install's token request needs, read so that a failed read is
 * not mistaken for an empty setting, as entraOAuthConfiguration's sign-in path
 * treats it. Advice to replace a secret must rest on a confirmed absence.
 */
async function readEntraSettings(): Promise<{ unreadable: string[]; absent: string[] }> {
    const mode = await getTenancyMode().catch(() => null);
    if (!mode) return { unreadable: ["tenancy-mode"], absent: [] };
    const names = mode === "pooled" ? POOLED_SETTINGS : SINGLE_SETTINGS;
    const read = await Promise.all(names.map(async (name) => {
        try {
            return { name, state: await optionalStampConfig(name) ? "set" : "absent" };
        } catch {
            return { name, state: "unreadable" };
        }
    }));
    const named = (state: string) => read.filter((item) => item.state === state).map((item) => item.name);
    return { unreadable: named("unreadable"), absent: named("absent") };
}

/** A warning, not a failure: nothing says the secret is bad, and rotating it would not help. */
function couldNotRead(names: string[], consequence: string): CheckOutcome {
    const list = names.join(", ");
    return {
        status: "warn",
        detail: `Could not read ${list} from Key Vault, so ${consequence}.`,
        remediation: "Do not rotate the client secret on this result. Check Key Vault access and the outage first, then reload this page.",
    };
}

/** A pooled stamp's token request tests the External ID client only. */
const ENTERPRISE_SECRET_NOT_TESTED = "The enterprise entra-client-secret was not tested: its authority is organizations, which a client_credentials request cannot use.";

function entraErrorCodes(body: unknown): number[] {
    const source = (body ?? {}) as { error_codes?: unknown; error_description?: unknown };
    if (Array.isArray(source.error_codes)) {
        return source.error_codes.filter((code): code is number => Number.isInteger(code));
    }
    if (typeof source.error_description !== "string") return [];
    const match = /AADSTS(\d+)/.exec(source.error_description);
    return match ? [Number(match[1])] : [];
}

/** Map a token endpoint error body to an outcome. Only the numeric code survives. */
export function mapEntraTokenError(body: unknown, httpStatus: number, secretName: string): CheckOutcome {
    const codes = entraErrorCodes(body);
    const remediation = replaceSecretRemedy(secretName);
    if (codes.includes(7000222)) {
        return { status: "fail", detail: "Entra says the client secret has expired (AADSTS7000222).", remediation };
    }
    if (codes.includes(7000215)) {
        // Worded to survive the output scrubber, which treats "secret is <word>" as a value.
        return { status: "fail", detail: "Entra rejected the client secret as invalid (AADSTS7000215).", remediation };
    }
    if (codes.includes(700016)) {
        // A pooled stamp's token request takes its directory from the authority.
        const settings = secretName.startsWith("altien-")
            ? ["altien-entra-client-id", "altien-entra-tenant-id", "altien-entra-authority"]
            : ["entra-client-id", "entra-tenant-id"];
        const names = settings.join(", ");
        const pickedUp = configPickup(settings);
        return {
            status: "fail",
            detail: "Entra cannot find this app registration in the tenant (AADSTS700016).",
            remediation: `Check that ${names} name the app registration this install uses, and correct them in Key Vault, ${pickedUp}.`,
        };
    }
    // Others (conditional access on workload identities, for example) need not
    // mean the secret is bad, so they do not claim that it is.
    const detail = codes.length
        ? `Entra refused the request (AADSTS${codes[0]}).`
        : `Entra refused the request with no AADSTS code (HTTP ${httpStatus}).`;
    return {
        status: "warn",
        detail,
        remediation: "Look up this AADSTS code in the Microsoft Entra error reference, and try signing in to see whether users are affected.",
    };
}

const NOT_TESTED = "the client secret was not tested";

async function clientSecretAccepted(signal: AbortSignal): Promise<CheckOutcome> {
    const settings = await readEntraSettings();
    if (settings.unreadable.length) return couldNotRead(settings.unreadable, NOT_TESTED);
    const secretName = settings.absent.find((name) => name.endsWith("-client-secret"));
    if (secretName) {
        return { status: "fail", detail: `${secretName} has no value.`, remediation: replaceSecretRemedy(secretName) };
    }
    if (settings.absent.length) {
        const names = settings.absent.join(", ");
        const pickedUp = configPickup(settings.absent);
        return {
            status: "fail",
            detail: `The Entra configuration is incomplete: no value for ${names}.`,
            remediation: `Set ${names} in Key Vault, ${pickedUp}.`,
        };
    }
    const config = await entraOAuthConfiguration().catch(() => null);
    if (!config) {
        return {
            status: "fail",
            detail: "The Entra configuration could not be used, although every setting has a value.",
            remediation: "Check the Entra settings' values in Key Vault: a pooled stamp's authority, issuer and JWKS URI must be plain https URLs.",
        };
    }
    const outcome = await requestClientCredentialsToken(config, signal);
    if (config.kind !== "altien") return outcome;
    return { ...outcome, detail: `${outcome.detail} ${ENTERPRISE_SECRET_NOT_TESTED}` };
}

async function requestClientCredentialsToken(
    config: Awaited<ReturnType<typeof entraOAuthConfiguration>>,
    signal: AbortSignal,
): Promise<CheckOutcome> {
    const secretName = config.kind === "altien" ? "altien-entra-client-secret" : "entra-client-secret";
    // Read as set a moment ago, so empty here is entraOAuthConfiguration swallowing a read failure.
    if (!config.clientSecret) return couldNotRead([secretName], NOT_TESTED);
    let response: Response;
    try {
        response = await fetch(`${config.authority}/oauth2/v2.0/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "client_credentials",
                client_id: config.clientId,
                client_secret: config.clientSecret,
                scope: GRAPH_SCOPE,
            }),
            signal,
        });
    } catch {
        if (signal.aborted) throw new Error("Timed out");
        return {
            status: "warn",
            detail: "Could not reach the Entra token endpoint, so the secret was not tested.",
            remediation: "Check the backend's outbound access to login.microsoftonline.com.",
        };
    }
    if (response.ok) {
        await response.body?.cancel().catch(() => {});
        return { status: "pass", detail: "Entra accepted the client secret. The token was discarded." };
    }
    const body = await response.json().catch(() => null);
    return mapEntraTokenError(body, response.status, secretName);
}

function isoDate(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
}

function endOf(credential: GraphCredential): number {
    return typeof credential.endDateTime === "string" ? Date.parse(credential.endDateTime) : Number.NaN;
}

function nameOf(credential: GraphCredential): string {
    const name = typeof credential.displayName === "string" ? credential.displayName.trim().slice(0, 80) : "";
    return name || "an unnamed credential";
}

/**
 * Find the credential in use by Graph's `hint` (the secret's first three
 * characters) and judge its expiry. The secret and hint appear in no output.
 */
export function assessCredentials(
    secret: string,
    credentials: GraphCredential[],
    secretName: string,
    now = Date.now(),
): CheckOutcome {
    const hint = secret.slice(0, 3);
    const inUse = credentials.filter((credential) => credential.hint === hint);
    const others = credentials.filter((credential) => credential.hint !== hint);
    const end = inUse.length === 1 ? endOf(inUse[0]) : Number.NaN;
    const days = Math.floor((end - now) / DAY_MS);

    let outcome: CheckOutcome;
    if (inUse.length === 0) {
        outcome = { status: "info", detail: "No credential on the app registration matches the secret in use, so its expiry date is unknown." };
    } else if (inUse.length > 1) {
        outcome = { status: "info", detail: "More than one credential could be the secret in use, so its expiry date is unknown." };
    } else if (Number.isNaN(end)) {
        outcome = { status: "info", detail: "Graph gave no end date for the secret in use, so its expiry date is unknown." };
    } else if (end <= now) {
        outcome = { status: "fail", detail: `The secret in use expired on ${isoDate(end)}.`, remediation: replaceSecretRemedy(secretName) };
    } else if (days < WARN_WITHIN_DAYS) {
        outcome = { status: "warn", detail: `The secret in use expires on ${isoDate(end)} (${days} days).`, remediation: replaceSecretRemedy(secretName) };
    } else {
        outcome = { status: "pass", detail: `The secret in use expires on ${isoDate(end)} (${days} days).` };
    }

    const expiringSoon = others.filter((credential) => {
        const otherEnd = endOf(credential);
        return otherEnd > now && otherEnd - now < WARN_WITHIN_DAYS * DAY_MS;
    });
    if (!expiringSoon.length) return outcome;
    const names = expiringSoon.map(nameOf).join(", ");
    return {
        status: outcome.status === "fail" ? "fail" : "warn",
        detail: `${outcome.detail} Also expiring within ${WARN_WITHIN_DAYS} days: ${names}.`,
        remediation: outcome.remediation
            ?? "Remove those credentials if nothing uses them, or replace them before they expire.",
    };
}

function expiryUnknown(reason: string): CheckOutcome {
    return { status: "info", detail: `${reason} The expiry date is unknown. The check above still tests the secret itself.` };
}

async function clientSecretExpiry(signal: AbortSignal): Promise<CheckOutcome> {
    const NOT_CHECKED = "the client secret's expiry was not checked";
    const settings = await readEntraSettings();
    if (settings.unreadable.length) return couldNotRead(settings.unreadable, NOT_CHECKED);
    if (settings.absent.some((name) => name.endsWith("-client-secret"))) {
        return expiryUnknown("The Entra client secret is not configured.");
    }
    const config = await entraOAuthConfiguration().catch(() => null);
    if (!config) return expiryUnknown("The Entra configuration is incomplete.");
    if (!config.clientSecret) return couldNotRead(["the client secret"], NOT_CHECKED);
    if (config.kind === "altien") {
        return expiryUnknown("External ID app registrations are in another directory, which the managed identity cannot read.");
    }
    const token = await mintGraphToken().catch(() => null);
    if (!token) return expiryUnknown("The managed identity could not get a Graph token.");
    let response: Response;
    try {
        response = await fetch(
            `${GRAPH_BASE}/applications(appId='${encodeURIComponent(config.clientId)}')?$select=passwordCredentials`,
            { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal },
        );
    } catch {
        if (signal.aborted) throw new Error("Timed out");
        return expiryUnknown("Could not reach Graph.");
    }
    if (!response.ok) return expiryUnknown(`Graph refused access to the app registration (HTTP ${response.status}).`);
    const body = await response.json().catch(() => null) as { passwordCredentials?: unknown } | null;
    if (!Array.isArray(body?.passwordCredentials)) return expiryUnknown("Graph did not return the app's credentials.");
    return assessCredentials(config.clientSecret, body.passwordCredentials as GraphCredential[], "entra-client-secret");
}

/** The host the sign-in callbacks use: as in auth.routes.ts, the request's only as a last resort. */
async function publicHost(requestHost: string): Promise<string> {
    const configured = process.env.API_PUBLIC_URL || await getConfig("backend-public-url").catch(() => "");
    try {
        return new URL(configured).host;
    } catch {
        return requestHost;
    }
}

async function redirectUris(requestHost: string): Promise<CheckOutcome> {
    const backendFqdn = await publicHost(requestHost);
    const result = await checkRedirectUris({ backendFqdn, keyVaultName: "", resourceGroup: "" });
    if (result.status === "pass") return { status: "pass", detail: `Registered for ${backendFqdn}: ${result.detail ?? ""}.` };
    // Its info and error details can carry an SDK message; its "Missing" detail
    // is a list of the URIs this page would show anyway.
    if (result.status === "fail" && result.detail?.startsWith("Missing ")) {
        return {
            status: "fail",
            detail: result.detail.replace(/ Run register-redirect-uris\.ps1\.$/, ""),
            remediation: `Run scripts/install/register-redirect-uris.ps1 -KeyVaultName <kv> -BackendFqdn ${backendFqdn}.`,
        };
    }
    if (result.status === "fail") {
        return {
            status: "warn",
            detail: "Could not compare the redirect URIs with the app registration.",
            remediation: "Check that entra-client-id is set and that Graph is reachable, then reload this page.",
        };
    }
    return { status: "info", detail: "Could not verify through Graph. The managed identity needs read access to the app registration, or a grant may still be propagating." };
}

function entraOnly(run: HealthCheck["run"]): HealthCheck["run"] {
    return async (signal) => {
        const provider = (process.env.AUTH_PROVIDER ?? "supabase").toLowerCase();
        if (provider !== "entra") return { status: "skip", detail: `Auth provider is ${provider}, not entra.` };
        return run(signal);
    };
}

export function entraChecks(requestHost: string): HealthCheck[] {
    const group = "Entra";
    return [
        { id: "entra.client-secret", group, title: "Client secret accepted", run: entraOnly(clientSecretAccepted) },
        { id: "entra.client-secret-expiry", group, title: "Client secret expiry", run: entraOnly(clientSecretExpiry) },
        { id: "entra.redirect-uris", group, title: "Redirect URIs registered", run: entraOnly(() => redirectUris(requestHost)) },
    ];
}
