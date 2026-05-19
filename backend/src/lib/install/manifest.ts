// v1 manifest catalog and evaluator. See issue 023 §"v1 manifest item
// catalog" for the full target list — this catalog covers the bulk of v1
// across all sections. Each item knows how to verify itself (`check`)
// and how the operator fixes it when the check fails (`fixedBy`).

import { getConfig } from "../config";
import { checkRedirectUris } from "./checks/redirectUris";
import { checkInstallerAccessRevoked } from "./checks/installerAccess";
import {
    type CheckResult,
    type EvaluatedItem,
    type InstallContext,
    type ManifestItem,
} from "./types";

// Default formatter: show the value as-is for short values (GUIDs,
// URLs, mode strings), strip any `# display-name` suffix per the
// install configurator surface (matches installAuth.ts:isInAdminGroup).
function defaultDisplay(raw: string): string {
    // Strip `# comment` if present — that's a documentation aid in the
    // KV value, not part of the operative value.
    const clean = raw.split("#")[0].trim();
    return clean;
}

// Redacted display for secrets — first 4 chars then bullets. Tells the
// operator the value IS set without revealing it.
function redactedDisplay(raw: string): string {
    if (raw.length === 0) return "";
    if (raw.length <= 4) return "••••";
    return `${raw.slice(0, 4)}••••`;
}

type CheckKvSecretOpts = {
    format?: RegExp;
    formatHint?: string;
    /**
     * How to render the value when the row is green. Defaults to
     * showing the value as-is (safe for GUIDs, URLs, mode strings).
     * Pass `redacted: true` for secrets, or a custom formatter for
     * special cases (e.g., display-name extraction).
     */
    redacted?: boolean;
    displayValue?: (raw: string) => string;
};

// Azure SDK throws a RestError with code 'SecretNotFound' (HTTP 404)
// when the KV secret doesn't exist. We treat that as "operator hasn't
// configured this yet" — semantically equivalent to value === "" — and
// render a clean human message rather than leaking the SDK error.
// Any other thrown error IS an unexpected failure (KV unreachable,
// auth denied, etc.) and surfaces its message so we can diagnose.
// Closes 040 Entry 1 problem 1.
function isSecretNotFound(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as { code?: unknown; statusCode?: unknown };
    return e.code === "SecretNotFound" || e.statusCode === 404;
}

async function checkKvSecret(
    name: string,
    opts: CheckKvSecretOpts = {},
): Promise<CheckResult> {
    try {
        const value = await getConfig(name);
        if (!value) return { status: "fail", detail: "Not yet configured." };
        if (opts.format && !opts.format.test(value)) {
            return {
                status: "fail",
                detail: `Format check failed${opts.formatHint ? ` (expected ${opts.formatHint})` : ""}.`,
            };
        }
        // Show the current value on pass so operators can verify it's
        // what they expect without clicking Edit. Sensitive values
        // (client secrets, HMAC keys) pass `redacted: true` so the row
        // shows that something is set without revealing the secret.
        // See gap #30 in 036-marketplace-install-gaps.md.
        const formatter = opts.displayValue ?? (opts.redacted ? redactedDisplay : defaultDisplay);
        return { status: "pass", detail: formatter(value) };
    } catch (err) {
        if (isSecretNotFound(err)) {
            return { status: "fail", detail: "Not yet configured." };
        }
        return {
            status: "fail",
            detail: err instanceof Error ? err.message : String(err),
        };
    }
}

const items: ManifestItem[] = [
    // ── Foundations ──────────────────────────────────────────────────
    {
        id: "bicep-deployed",
        label: "Mike's backend is up and running",
        section: "Core setup",
        required: true,
        check: async () => ({
            status: "pass",
            detail: "If you can read this page, the Container App is up.",
        }),
        fixedBy: { type: "auto", description: "Bicep provisions the Container App." },
    },
    {
        id: "mi-client-id",
        label: "Backend can talk to Azure (managed identity wired)",
        section: "Core setup",
        required: true,
        check: async () => {
            const env = process.env.AZURE_CLIENT_ID ?? "";
            if (!env) {
                return { status: "fail", detail: "AZURE_CLIENT_ID env var is not set." };
            }
            return { status: "pass", detail: env };
        },
        fixedBy: { type: "auto", description: "Bicep threads `mi.outputs.miClientId` into the env." },
    },
    {
        id: "kv-bootstrap-token",
        label: "First-time setup password ready",
        section: "Core setup",
        required: true,
        check: () => checkKvSecret("install-bootstrap-token", { redacted: true }),
        fixedBy: { type: "auto", description: "Bicep generates and writes on greenfield deploy." },
    },
    {
        id: "kv-auth-state-secret",
        label: "Sign-in signing key ready",
        section: "Core setup",
        required: true,
        check: () => checkKvSecret("auth-state-secret", { redacted: true }),
        fixedBy: { type: "auto", description: "Bicep generates on greenfield deploy." },
    },
    {
        id: "kv-backend-public-url",
        label: "Backend's public web address",
        section: "Core setup",
        required: true,
        check: () => checkKvSecret("backend-public-url", {
            format: /^https?:\/\/.+/,
            formatHint: "URL with scheme",
        }),
        fixedBy: {
            type: "in-app-form",
            submitTo: "kv",
            fields: [{
                name: "backend-public-url",
                label: "Backend public URL",
                type: "url",
                placeholder: "https://backend.<env>.azurecontainerapps.io",
                required: true,
                pattern: "^https?:\\/\\/.+",
            }],
        },
    },
    {
        // Optional override consumed by the script-arg renderer in
        // install.ts: when set, every `<fqdn>` substitution uses this
        // value instead of the host the operator reached /install on.
        // Lets you register Entra redirect URIs against a custom domain
        // (e.g. mike.altien.com) before the custom domain itself is
        // wired up on Container Apps ingress.
        id: "custom-backend-fqdn",
        label: "Custom domain name (optional)",
        section: "Core setup",
        required: false,
        check: async () => {
            const value = await getConfig("custom-backend-fqdn").catch(() => "");
            if (!value) {
                return {
                    status: "info",
                    detail: "Not set — script <fqdn> defaults to the host you opened /install on.",
                };
            }
            return { status: "pass", detail: value };
        },
        fixedBy: {
            type: "in-app-form",
            submitTo: "kv",
            fields: [{
                name: "custom-backend-fqdn",
                label: "Custom backend FQDN",
                type: "text",
                placeholder: "mike.altien.com",
                required: false,
                pattern: "^[a-z0-9.-]+$",
                helpText: "Hostname only, no scheme or path (e.g. mike.altien.com). Substituted into -BackendFqdn on the create-entra-apps and register-redirect-uris commands. Leave empty to use the host you reached /install on.",
            }],
        },
    },

    // ── AI providers ─────────────────────────────────────────────────
    {
        id: "ai-anthropic-key",
        label: "Anthropic API key",
        section: "AI providers",
        required: false,
        check: () => checkKvSecret("anthropic-api-key", {
            format: /^sk-ant-/,
            formatHint: "sk-ant- prefix",
            redacted: true,
        }),
        fixedBy: {
            type: "in-app-form",
            submitTo: "kv",
            fields: [{
                name: "anthropic-api-key",
                label: "Anthropic API key",
                type: "password",
                placeholder: "sk-ant-…",
                required: true,
                pattern: "^sk-ant-.+",
            }],
        },
    },
    {
        id: "ai-openai-key",
        label: "OpenAI API key",
        section: "AI providers",
        required: false,
        check: () => checkKvSecret("openai-api-key", {
            format: /^sk-(proj-)?/,
            formatHint: "sk- or sk-proj- prefix",
            redacted: true,
        }),
        fixedBy: {
            type: "in-app-form",
            submitTo: "kv",
            fields: [{
                name: "openai-api-key",
                label: "OpenAI API key",
                type: "password",
                placeholder: "sk-…",
                required: true,
            }],
        },
    },
    {
        id: "ai-gemini-key",
        label: "Google Gemini API key",
        section: "AI providers",
        required: false,
        check: () => checkKvSecret("gemini-api-key", {
            format: /^AIza/,
            formatHint: "AIza prefix",
            redacted: true,
        }),
        fixedBy: {
            type: "in-app-form",
            submitTo: "kv",
            fields: [{
                name: "gemini-api-key",
                label: "Google Gemini API key",
                type: "password",
                placeholder: "AIza…",
                required: true,
                pattern: "^AIza.+",
            }],
        },
    },
    {
        id: "ai-aoai-config",
        label: "Azure OpenAI / AI Foundry",
        section: "AI providers",
        required: false,
        check: async () => {
            const endpoint = await checkKvSecret("azure-openai-endpoint", {
                format: /^https:\/\/.+/,
                formatHint: "https:// URL",
            });
            if (endpoint.status !== "pass") return endpoint;
            const key = await checkKvSecret("azure-openai-api-key", { redacted: true });
            if (key.status !== "pass") return key;
            // Show the endpoint and a redacted-key marker so operators can
            // verify the endpoint matches expectations at a glance (gap #30).
            return { status: "pass", detail: `${endpoint.detail ?? ""} · key set` };
        },
        fixedBy: {
            type: "in-app-form",
            submitTo: "kv",
            fields: [
                {
                    name: "azure-openai-endpoint",
                    label: "AOAI endpoint",
                    type: "url",
                    placeholder: "https://<account>.openai.azure.com/",
                    required: true,
                    pattern: "^https:\\/\\/.+",
                    helpText: "The base URL of your Azure OpenAI or Azure AI Foundry resource. Find it in the Azure portal under your resource → Keys and Endpoint → Endpoint.",
                },
                {
                    name: "azure-openai-api-key",
                    label: "AOAI API key",
                    type: "password",
                    placeholder: "AOAI account key",
                    required: true,
                    helpText: "Either KEY 1 or KEY 2 from your resource's Keys and Endpoint blade. Mike treats them interchangeably; rotate by running the script in provision mode (or via the Azure portal).",
                },
            ],
            alsoAsScript: {
                scriptName: "setup-aoai.ps1",
                argsTemplate: "-KeyVaultName <kv> -Provision -ResourceGroup <rg> -Region <region> -Model <model>",
                description: "Need to provision a brand-new AOAI / Foundry resource and a model deployment in one step? Pick region + model below, copy the command, and run it locally.",
                tweakOptions: [
                    {
                        name: "region",
                        label: "Region",
                        defaultValue: "uksouth",
                        // AOAI quota varies sharply by region. These regions are
                        // the most commonly available; others throttle hard or
                        // gate behind capacity requests.
                        options: [
                            "uksouth",
                            "westeurope",
                            "northeurope",
                            "swedencentral",
                            "francecentral",
                            "switzerlandnorth",
                            "eastus",
                            "eastus2",
                            "southcentralus",
                            "canadaeast",
                            "australiaeast",
                            "japaneast",
                        ],
                    },
                    {
                        name: "model",
                        label: "Model",
                        defaultValue: "gpt-4o-mini",
                        options: [
                            "gpt-4o-mini",
                            "gpt-4o",
                            "gpt-4-turbo",
                            "gpt-4",
                            "gpt-35-turbo",
                        ],
                    },
                ],
            },
        },
    },

    // ── Entra ID ─────────────────────────────────────────────────────
    // The three identity items below all read from KV secrets that
    // create-entra-apps.ps1 writes. Each item has its own paste form so
    // operators who created the apps in the portal (or in another
    // automation) can fill the values manually. Only the first item
    // (entra-tenant-id) renders the script Run block via `alsoAsScript`
    // — the script writes ALL FIVE secrets in one pass (tenant id,
    // backend app id, frontend app id, frontend client secret, plus a
    // backend-scope row that is no longer manifest-tracked because it's
    // deterministic from the backend client id; see gap #4 in
    // docs/issues/azure-migration/036-marketplace-install-gaps.md), so
    // showing the same command three times added no value and obscured
    // the independent paste paths.
    {
        id: "entra-tenant-id",
        label: "Microsoft tenant (your organization)",
        section: "Microsoft sign-in",
        required: true,
        // Marketplace operators should run create-entra-apps.ps1 (offered
        // via alsoAsScript below) — that single command writes tenant id,
        // both app reg ids, and the frontend client secret to KV in one
        // pass. The paste form is retained for OSS deployments and
        // operators who created the apps in the portal. Marked `advanced`
        // so the UI de-emphasizes it. 036a Phase 6 (B6).
        advanced: true,
        check: () => checkKvSecret("entra-tenant-id", {
            format: /^[0-9a-f-]{36}$/i,
            formatHint: "GUID",
        }),
        fixedBy: {
            type: "in-app-form",
            submitTo: "kv",
            fields: [{
                name: "entra-tenant-id",
                label: "Tenant ID",
                type: "text",
                placeholder: "00000000-0000-0000-0000-000000000000",
                required: true,
                pattern: "^[0-9a-fA-F-]{36}$",
                helpText: "The unique ID of your Microsoft organization. Mike uses this to know which Microsoft accounts can sign in. Find it in the Azure portal → Microsoft Entra ID → Overview → Tenant ID.",
            }],
            alsoAsScript: {
                scriptName: "create-entra-apps.ps1",
                argsTemplate: "-KeyVaultName <kv> -BackendFqdn <fqdn> -ResourceGroup <rg>",
                description: "Recommended: run this script to create the backend + frontend app registrations and write all the Entra secrets (tenant ID, both app reg ids, frontend client secret) to KV in one pass. Resource group is used to look up the backend UAMI and grant it ownership of the frontend app reg, which lets /install read the redirect URIs back via Graph for slice 9 verification.",
            },
        },
    },
    {
        id: "entra-backend-app",
        label: "Sign-in: backend identity",
        section: "Microsoft sign-in",
        required: true,
        requires: ["entra-tenant-id"],
        // Same rationale as entra-tenant-id: marketplace path is the
        // script. Paste form retained for OSS / portal-created apps.
        advanced: true,
        check: () => checkKvSecret("entra-backend-client-id", {
            format: /^[0-9a-f-]{36}$/i,
            formatHint: "GUID",
        }),
        fixedBy: {
            type: "in-app-form",
            submitTo: "kv",
            fields: [{
                name: "entra-backend-client-id",
                label: "Backend app (API) client ID",
                type: "text",
                placeholder: "00000000-0000-0000-0000-000000000000",
                required: true,
                pattern: "^[0-9a-fA-F-]{36}$",
                helpText: "The ID Microsoft uses to identify Mike's backend when validating sign-ins. Find it in the Azure portal → Microsoft Entra ID → App registrations → your backend app → Overview → Application (client) ID.",
            }],
        },
    },
    {
        id: "entra-frontend-app",
        label: "Sign-in: user-facing identity",
        section: "Microsoft sign-in",
        required: true,
        requires: ["entra-tenant-id"],
        // Same rationale as entra-tenant-id / entra-backend-app.
        advanced: true,
        check: () => checkKvSecret("entra-client-id", {
            format: /^[0-9a-f-]{36}$/i,
            formatHint: "GUID",
        }),
        fixedBy: {
            type: "in-app-form",
            submitTo: "kv",
            fields: [
                {
                    name: "entra-client-id",
                    label: "Frontend (sign-in) client ID",
                    type: "text",
                    placeholder: "00000000-0000-0000-0000-000000000000",
                    required: true,
                    pattern: "^[0-9a-fA-F-]{36}$",
                    helpText: "The ID Microsoft uses to identify Mike to your users when they sign in. Find it in the Azure portal → Microsoft Entra ID → App registrations → your sign-in app → Overview → Application (client) ID.",
                },
                {
                    name: "entra-client-secret",
                    label: "Sign-in client secret",
                    type: "password",
                    placeholder: "Paste the secret VALUE (not the Secret ID)",
                    required: true,
                    helpText: "A password Microsoft generates for Mike to prove its identity. Mint a new one in the Azure portal → Microsoft Entra ID → App registrations → your sign-in app → Certificates & secrets → New client secret. Copy the VALUE column (not Secret ID).",
                },
            ],
        },
    },
    // entra-backend-scope row removed: the scope is `api://<backend-client-id>/access_as_user`,
    // fully derivable at runtime in routes/auth.ts's entraScopes(). Tracking it as a separate
    // KV secret was the source of "all green except this row, with no fix path" failures.
    // create-entra-apps.ps1 still writes the KV secret for backward compatibility with older
    // installs; no code consults it. Gap #4 in 036-marketplace-install-gaps.md.
    {
        id: "entra-frontend-redirect-uris",
        label: "Sign-in callback URLs registered",
        section: "Microsoft sign-in",
        required: true,
        requires: ["entra-frontend-app", "kv-backend-public-url"],
        // Real Microsoft Graph round-trip — see checks/redirectUris.ts.
        check: (ctx) => checkRedirectUris(ctx),
        fixedBy: {
            type: "external-script",
            scriptName: "register-redirect-uris.ps1",
            argsTemplate: "-KeyVaultName <kv> -BackendFqdn <fqdn>",
        },
    },

    // ── Tenant policy ────────────────────────────────────────────────
    {
        id: "entra-admin-group-id",
        label: "Admins (who can configure Mike)",
        section: "Access rules",
        required: true,
        requires: ["entra-frontend-app"],
        check: () => checkKvSecret("entra-admin-group-ids", {
            format: /^[0-9a-f-]{36}/i,
            formatHint: "GUID (the secret may also include a display-name comment)",
        }),
        // Picker only.  Issue 023 invariant: NEVER expose a GUID-paste
        // fallback — operators don't know GUIDs by heart, pasted GUIDs
        // are unverified, every other Azure picker is searchable.  Slice 8
        // wires the Graph-backed picker; until then this item is action-
        // less by design (no FORM, no SCRIPT, just a planned milestone).
        fixedBy: {
            type: "auto",
            description: "Group picker UI lands in slice 8 (Graph /me/memberOf + search).",
        },
    },
    {
        id: "entra-member-group-id",
        label: "Users (who can use Mike, optional)",
        section: "Access rules",
        required: false,
        requires: ["entra-frontend-app"],
        check: () => checkKvSecret("entra-member-group-ids"),
        fixedBy: {
            type: "auto",
            description: "Group picker UI lands in slice 8 (Graph /me/memberOf + search).",
        },
    },
    {
        id: "tenant-onboarding-mode",
        label: "New sign-up handling (auto vs manual)",
        section: "Access rules",
        required: true,
        check: async () => {
            const value = await getConfig("tenant-onboarding-mode").catch(() => "");
            if (value === "auto" || value === "manual") {
                return { status: "pass", detail: value };
            }
            return { status: "fail", detail: "Set to 'auto' or 'manual'." };
        },
        fixedBy: {
            type: "in-app-form",
            submitTo: "kv",
            fields: [{
                name: "tenant-onboarding-mode",
                label: "Tenant onboarding mode",
                type: "text",
                required: true,
                options: ["auto", "manual"],
                helpText: "auto: any user from your Microsoft organization can sign in straight away — best for single-tenant installs. manual: an admin must explicitly enrol each new Microsoft organization before its users can sign in — best for multi-tenant SaaS scenarios.",
            }],
        },
    },

    // ── Lifecycle ────────────────────────────────────────────────────
    {
        id: "bootstrap-retired",
        label: "First-time setup completed (bootstrap retired)",
        section: "Cleanup",
        required: true,
        check: async () => {
            const tok = await getConfig("install-bootstrap-token").catch(() => "");
            if (!tok) {
                return { status: "pass", detail: "Token is empty/missing — bootstrap retired." };
            }
            return {
                status: "info",
                detail: "Bootstrap still active; first Entra admin sign-in retires it (slice 8).",
            };
        },
        fixedBy: {
            type: "auto",
            description: "Auto-retires when the first valid Entra admin session loads /install.",
        },
    },
    {
        id: "installer-access-revoked",
        label: "Installer's setup access removed",
        section: "Cleanup",
        required: false,
        // Real ARM round-trip — see checks/installerAccess.ts.
        check: (ctx) => checkInstallerAccessRevoked(ctx),
        fixedBy: {
            type: "external-script",
            scriptName: "revoke-installer-access.ps1",
            argsTemplate: "-KeyVaultName <kv>",
        },
    },

    // ── Optional ─────────────────────────────────────────────────────
    {
        id: "app-insights-connection",
        label: "Application Insights (telemetry / monitoring)",
        section: "Optional",
        required: false,
        check: () => checkKvSecret("appinsights-connection-string", { redacted: true }),
        fixedBy: {
            type: "in-app-form",
            submitTo: "kv",
            fields: [{
                name: "appinsights-connection-string",
                label: "Application Insights connection string",
                type: "password",
                placeholder: "InstrumentationKey=…;IngestionEndpoint=…",
                required: false,
            }],
        },
    },
];

export function findManifestItem(id: string): ManifestItem | undefined {
    return items.find((i) => i.id === id);
}

export async function evaluateManifest(
    ctx: InstallContext,
): Promise<EvaluatedItem[]> {
    const results = await Promise.all(
        items.map(async (item) => {
            const result = await item.check(ctx).catch(
                (err): CheckResult => ({
                    status: "fail",
                    detail: err instanceof Error ? err.message : String(err),
                }),
            );
            return { ...item, result };
        }),
    );
    const byId = new Map(results.map((r) => [r.id, r]));
    return results.map((r) => {
        const requires = r.requires ?? [];
        const canAct = requires.every(
            (reqId) => byId.get(reqId)?.result.status === "pass",
        );
        return { ...r, canAct };
    });
}
