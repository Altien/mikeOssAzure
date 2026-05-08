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

async function checkKvSecret(
    name: string,
    opts: { format?: RegExp; formatHint?: string } = {},
): Promise<CheckResult> {
    try {
        const value = await getConfig(name);
        if (!value) return { status: "fail", detail: "Not set." };
        if (opts.format && !opts.format.test(value)) {
            return {
                status: "fail",
                detail: `Format check failed${opts.formatHint ? ` (expected ${opts.formatHint})` : ""}.`,
            };
        }
        return { status: "pass", detail: `length=${value.length}` };
    } catch (err) {
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
        label: "Container App is serving",
        section: "Foundations",
        required: true,
        check: async () => ({
            status: "pass",
            detail: "If you can read this page, the Container App is up.",
        }),
        fixedBy: { type: "auto", description: "Bicep provisions the Container App." },
    },
    {
        id: "mi-client-id",
        label: "AZURE_CLIENT_ID matches the attached UAMI",
        section: "Foundations",
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
        label: "Bootstrap token stored in Key Vault",
        section: "Foundations",
        required: true,
        check: () => checkKvSecret("install-bootstrap-token"),
        fixedBy: { type: "auto", description: "Bicep generates and writes on greenfield deploy." },
    },
    {
        id: "kv-auth-state-secret",
        label: "Auth state secret stored in Key Vault",
        section: "Foundations",
        required: true,
        check: () => checkKvSecret("auth-state-secret"),
        fixedBy: { type: "auto", description: "Bicep generates on greenfield deploy." },
    },
    {
        id: "kv-backend-public-url",
        label: "Backend public URL recorded in Key Vault",
        section: "Foundations",
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
        label: "Custom backend FQDN (overrides redirect-URI hostnames)",
        section: "Foundations",
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
        label: "Azure OpenAI / Foundry endpoint + key",
        section: "AI providers",
        required: false,
        check: async () => {
            const endpoint = await checkKvSecret("azure-openai-endpoint", {
                format: /^https:\/\/.+/,
                formatHint: "https:// URL",
            });
            if (endpoint.status !== "pass") return endpoint;
            const key = await checkKvSecret("azure-openai-api-key");
            if (key.status !== "pass") return key;
            return { status: "pass", detail: "Endpoint + key present." };
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
    // — the script writes ALL THREE secrets in one pass, so showing
    // the same command three times added no value and obscured the
    // independent paste paths.
    {
        id: "entra-tenant-id",
        label: "Entra tenant ID",
        section: "Entra ID",
        required: true,
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
                helpText: "GUID of the Entra tenant. Find it in Azure portal → Microsoft Entra ID → Overview.",
            }],
            alsoAsScript: {
                scriptName: "create-entra-apps.ps1",
                argsTemplate: "-KeyVaultName <kv> -BackendFqdn <fqdn> -ResourceGroup <rg>",
                description: "Or run this script to create the backend + frontend app registrations and write all three Entra secrets (tenant ID, backend app ID, frontend app ID) at once. Resource group is used to look up the backend UAMI and grant it ownership of the frontend app reg, which lets /install read the redirect URIs back via Graph for slice 9 verification.",
            },
        },
    },
    {
        id: "entra-backend-app",
        label: "Backend app registration",
        section: "Entra ID",
        required: true,
        requires: ["entra-tenant-id"],
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
                helpText: "Application (client) ID of the backend API app registration. Find it under App registrations → <your backend app> → Overview.",
            }],
        },
    },
    {
        id: "entra-frontend-app",
        label: "Frontend app registration",
        section: "Entra ID",
        required: true,
        requires: ["entra-tenant-id"],
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
                    helpText: "Application (client) ID of the frontend / sign-in app registration.",
                },
                {
                    name: "entra-client-secret",
                    label: "Frontend client secret",
                    type: "password",
                    placeholder: "Paste a fresh client secret (Value, not Secret ID)",
                    required: true,
                    helpText: "A client secret on the frontend app. The backend exchanges authorization codes with this. Mint a new one under App registrations → Certificates & secrets → Client secrets if needed.",
                },
            ],
        },
    },
    {
        id: "entra-backend-scope",
        label: "Backend API scope (api://.../access_as_user)",
        section: "Entra ID",
        required: true,
        requires: ["entra-backend-app"],
        check: () => checkKvSecret("entra-backend-scope", {
            format: /^api:\/\/[0-9a-f-]+\/access_as_user$/i,
            formatHint: "api://<guid>/access_as_user",
        }),
        fixedBy: {
            type: "auto",
            description: "create-entra-apps.ps1 sets this from the backend app's identifierUri.",
        },
    },
    {
        id: "entra-frontend-redirect-uris",
        label: "Frontend redirect URIs match the backend FQDN",
        section: "Entra ID",
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
        label: "Admin group",
        section: "Tenant policy",
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
        label: "Member group (optional)",
        section: "Tenant policy",
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
        label: "Tenant onboarding mode",
        section: "Tenant policy",
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
                helpText: "auto = new tenants self-service via Microsoft sign-in (good for prod). manual = admins explicitly enrol each tenant before its users can sign in (good for dev / pilot).",
            }],
        },
    },

    // ── Lifecycle ────────────────────────────────────────────────────
    {
        id: "bootstrap-retired",
        label: "Bootstrap path retired (Entra admin sign-in seen)",
        section: "Lifecycle",
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
        label: "Installer's KV write access revoked",
        section: "Lifecycle",
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
        label: "Application Insights connection string",
        section: "Optional",
        required: false,
        check: () => checkKvSecret("appinsights-connection-string"),
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
