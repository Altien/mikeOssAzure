import { isProviderDisabled } from "./providerPreferences";
// Credentials for the providers whose keys only work together with a
// non-secret setting: Amazon Bedrock (an API key scoped to an AWS region),
// Azure OpenAI and Azure AI Foundry (an API key scoped to one Azure resource),
// Google Vertex AI (a service-account key used in one location) and a user's
// own OpenAI-compatible endpoint (a key for one base URL).
//
// A key and its setting always come from the same source. A user's saved key
// travels with the region/endpoint the user saved next to it; the
// deployment's environment key travels with the environment's
// region/endpoint. Mixing them would send a user's key to the operator's
// Azure resource, or the operator's key to a resource the user chose.

import { BLOCKED_METADATA_HOSTS } from "../mcp/types";
import { isBlockedIp } from "../privateIp";
import type { UserApiKeys } from "./types";
import { resolveProviderSecret } from "../envSecrets";

export type BedrockCredentials = { apiKey: string; region: string };
export type AzureCredentials = { apiKey: string; endpoint: string };
export type AzureFoundryCredentials = { apiKey: string; endpoint: string };
export type VertexServiceAccount = {
    clientEmail: string;
    privateKey: string;
    privateKeyId?: string;
    project: string;
};
export type VertexCredentials = VertexServiceAccount & { location: string };
export type CustomEndpointCredentials = { apiKey: string; baseUrl: string };

// AWS region codes: "us-east-1", "eu-central-2", "us-gov-west-1",
// "ap-southeast-5". Anything else is rejected rather than interpolated into
// the bedrock-runtime hostname.
const AWS_REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;

// An Azure resource name is a single DNS label; the SDK builds
// https://{name}.openai.azure.com from it.
const AZURE_RESOURCE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

// Full endpoints are limited to Azure's own AI hostnames. The endpoint is a
// user-supplied URL the backend sends requests (and the user's key) to, so an
// open URL would let any user point the server at an arbitrary host.
const AZURE_ENDPOINT_HOST_SUFFIXES = [
    ".openai.azure.com",
    ".cognitiveservices.azure.com",
    ".services.ai.azure.com",
];

// AWS partitions outside the commercial one have their own DNS suffix.
const AWS_PARTITION_DNS_SUFFIXES: ReadonlyArray<[RegExp, string]> = [
    [/^cn-/, "amazonaws.com.cn"],
    [/^us-isob-/, "sc2s.sgov.gov"],
    [/^us-isof-/, "csp.hci.ic.gov"],
    [/^us-iso-/, "c2s.ic.gov"],
    [/^eu-isoe-/, "cloud.adc-e.uk"],
    [/^eusc-/, "amazonaws.eu"],
];

/** The DNS suffix of the partition a (normalized) AWS region belongs to. */
export function awsDnsSuffix(region: string): string {
    return (
        AWS_PARTITION_DNS_SUFFIXES.find(([prefix]) => prefix.test(region))?.[1] ??
        "amazonaws.com"
    );
}

export function normalizeAwsRegion(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const region = value.trim().toLowerCase();
    return AWS_REGION_RE.test(region) ? region : null;
}

/**
 * An Azure OpenAI resource name ("contoso-openai") or an https endpoint on an
 * Azure AI hostname ("https://contoso-openai.openai.azure.com"), normalized
 * without a trailing slash. Returns null for anything else.
 */
export function normalizeAzureEndpoint(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 300) return null;
    if (AZURE_RESOURCE_NAME_RE.test(trimmed)) return trimmed.toLowerCase();

    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return null;
    }
    const hostname = url.hostname.toLowerCase();
    if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        url.search ||
        url.hash ||
        !AZURE_ENDPOINT_HOST_SUFFIXES.some(
            (suffix) =>
                hostname.endsWith(suffix) && hostname.length > suffix.length,
        )
    ) {
        return null;
    }
    const path = url.pathname.replace(/\/+$/, "");
    return `https://${hostname}${path}`;
}

/**
 * The Azure AI Foundry resource a key belongs to, as an https origin. Accepts
 * a resource name ("contoso-foundry" → https://contoso-foundry.services.ai.azure.com)
 * or an https URL on an Azure AI hostname; any path is dropped because the
 * adapter appends the API path of the protocol each deployment speaks.
 */
export function normalizeAzureFoundryEndpoint(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (AZURE_RESOURCE_NAME_RE.test(trimmed)) {
        return `https://${trimmed.toLowerCase()}.services.ai.azure.com`;
    }
    const endpoint = normalizeAzureEndpoint(trimmed);
    return endpoint ? new URL(endpoint).origin : null;
}

// Vertex AI locations are a single DNS label interpolated into the API
// hostname: "us-central1", "europe-west4", or the multi-region "global",
// "us" and "eu".
const VERTEX_LOCATION_RE = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;

export function normalizeVertexLocation(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const location = value.trim().toLowerCase();
    return VERTEX_LOCATION_RE.test(location) ? location : null;
}

// A project id is interpolated into the request path. Legacy ids carry a
// domain prefix ("example.com:my-project").
const GCP_PROJECT_ID_RE = /^(?:[a-z0-9.-]{1,60}:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const SERVICE_ACCOUNT_EMAIL_RE = /^[^\s@]{1,100}@[a-z0-9.-]{1,150}\.gserviceaccount\.com$/i;
const MAX_SERVICE_ACCOUNT_KEY_LENGTH = 16_000;

/**
 * The fields Mike uses from a Google Cloud service-account key file, or null
 * when the value is not one. Only these fields are read: a key file's own
 * `token_uri` and `universe_domain` are ignored, so a crafted file cannot
 * redirect the token exchange to another host.
 */
export function parseVertexServiceAccount(
    value: unknown,
): VertexServiceAccount | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_SERVICE_ACCOUNT_KEY_LENGTH) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
    }
    const record = parsed as Record<string, unknown>;
    const clientEmail = record.client_email;
    const privateKey = record.private_key;
    const project = record.project_id;
    const privateKeyId = record.private_key_id;
    if (
        record.type !== "service_account" ||
        typeof clientEmail !== "string" ||
        !SERVICE_ACCOUNT_EMAIL_RE.test(clientEmail) ||
        typeof privateKey !== "string" ||
        !privateKey.includes("-----BEGIN PRIVATE KEY-----") ||
        typeof project !== "string" ||
        !GCP_PROJECT_ID_RE.test(project)
    ) {
        return null;
    }
    return {
        clientEmail,
        privateKey,
        project,
        ...(typeof privateKeyId === "string" && privateKeyId
            ? { privateKeyId }
            : {}),
    };
}

/**
 * The base URL of a user's own OpenAI-compatible endpoint, without a trailing
 * slash, or null when it is not acceptable. The backend sends requests and
 * the user's key to this URL, so it must be public https: no credentials,
 * query or fragment, and no loopback, private or cloud-metadata host. This
 * is the save-time check; requests additionally go through the DNS-pinning
 * guarded fetch, which rejects a public name that resolves privately.
 */
export function normalizeCustomBaseUrl(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 300) return null;
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return null;
    }
    const hostname = url.hostname.toLowerCase();
    const literalHost =
        hostname.startsWith("[") && hostname.endsWith("]")
            ? hostname.slice(1, -1)
            : hostname;
    const isIpLiteral = /^[\d.]+$/.test(literalHost) || literalHost.includes(":");
    if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !hostname ||
        hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        BLOCKED_METADATA_HOSTS.has(hostname) ||
        (isIpLiteral ? isBlockedIp(literalHost) : !hostname.includes("."))
    ) {
        return null;
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** How `createAzure` should address a normalized endpoint. */
export function azureClientTarget(
    endpoint: string,
): { resourceName: string } | { baseURL: string } {
    if (!endpoint.startsWith("https://")) return { resourceName: endpoint };
    // A bare host has no API path; the SDK appends /v1 to an /openai base.
    const url = new URL(endpoint);
    return {
        baseURL: url.pathname === "/" || url.pathname === ""
            ? `${endpoint}/openai`
            : endpoint,
    };
}

// Upstream divergence (sync-log: 25779536): all cloud deployment inputs
// are awaited Key Vault-first values. Legacy helpers keep their names for
// upstream compatibility; environment variables are local fallbacks.
export async function envBedrockApiKey(): Promise<string | null> {
    return (await resolveProviderSecret("aws-bearer-token-bedrock", ["bedrock-api-key"])) || null;
}
export async function envBedrockRegion(): Promise<string | null> {
    return normalizeAwsRegion(await resolveProviderSecret("bedrock-aws-region", ["aws-region"]));
}
export async function envAzureApiKey(): Promise<string | null> {
    return (await resolveProviderSecret("azure-openai-api-key", ["azure-api-key"])) || null;
}
export async function envAzureEndpoint(): Promise<string | null> {
    return normalizeAzureEndpoint(await resolveProviderSecret("azure-openai-endpoint", ["azure-resource-name"]));
}
export async function envAzureFoundryCredentials(): Promise<AzureFoundryCredentials | null> {
    const [apiKey, rawEndpoint] = await Promise.all([
        resolveProviderSecret("azure-foundry-api-key"),
        resolveProviderSecret("azure-foundry-endpoint"),
    ]);
    const endpoint = normalizeAzureFoundryEndpoint(rawEndpoint);
    return apiKey && endpoint ? { apiKey, endpoint } : null;
}
export async function envVertexServiceAccountKey(): Promise<string | null> {
    return (await resolveProviderSecret("google-vertex-credentials-json")) || null;
}
export async function envVertexCredentials(): Promise<VertexCredentials | null> {
    const [key, rawLocation] = await Promise.all([
        envVertexServiceAccountKey(),
        resolveProviderSecret("google-vertex-location"),
    ]);
    const account = parseVertexServiceAccount(key);
    const location = normalizeVertexLocation(rawLocation);
    return account && location ? { ...account, location } : null;
}
export async function envBedrockCredentials(): Promise<BedrockCredentials | null> {
    const [apiKey, region] = await Promise.all([envBedrockApiKey(), envBedrockRegion()]);
    return apiKey && region ? { apiKey, region } : null;
}
export async function envAzureCredentials(): Promise<AzureCredentials | null> {
    const [apiKey, endpoint] = await Promise.all([envAzureApiKey(), envAzureEndpoint()]);
    return apiKey && endpoint ? { apiKey, endpoint } : null;
}
export async function envCustomEndpointCredentials(): Promise<CustomEndpointCredentials | null> {
    const [apiKey, rawUrl] = await Promise.all([
        resolveProviderSecret("custom-api-key"),
        resolveProviderSecret("custom-base-url"),
    ]);
    const baseUrl = normalizeCustomBaseUrl(rawUrl);
    return apiKey && baseUrl ? { apiKey, baseUrl } : null;
}

/**
 * Bedrock credentials for a request. A key in `apiKeys` must arrive with its
 * region; a key without one is unusable rather than paired with the
 * environment's region.
 */
export async function bedrockCredentials(
    apiKeys?: UserApiKeys,
): Promise<BedrockCredentials | null> {
    if (isProviderDisabled("bedrock", apiKeys)) return null;
    const apiKey = apiKeys?.bedrock?.trim();
    if (apiKey) {
        const region = normalizeAwsRegion(
            apiKeys?.providerSettings?.bedrock?.region,
        );
        return region ? { apiKey, region } : null;
    }
    return envBedrockCredentials();
}

/** Azure OpenAI credentials for a request; see bedrockCredentials. */
export async function azureCredentials(
    apiKeys?: UserApiKeys,
): Promise<AzureCredentials | null> {
    if (isProviderDisabled("azure", apiKeys)) return null;
    const apiKey = apiKeys?.azure?.trim();
    if (apiKey) {
        const endpoint = normalizeAzureEndpoint(
            apiKeys?.providerSettings?.azure?.endpoint,
        );
        return endpoint ? { apiKey, endpoint } : null;
    }
    const legacy = apiKeys?.azureOpenai;
    if (legacy?.apiKey) {
        const endpoint = normalizeAzureEndpoint(legacy.endpoint);
        return endpoint ? { apiKey: legacy.apiKey, endpoint } : null;
    }
    return envAzureCredentials();
}

/** Azure AI Foundry credentials for a request; see bedrockCredentials. */
export async function azureFoundryCredentials(
    apiKeys?: UserApiKeys,
): Promise<AzureFoundryCredentials | null> {
    if (isProviderDisabled("azure-foundry", apiKeys)) return null;
    const apiKey = apiKeys?.["azure-foundry"]?.trim();
    if (apiKey) {
        const endpoint = normalizeAzureFoundryEndpoint(
            apiKeys?.providerSettings?.["azure-foundry"]?.endpoint,
        );
        return endpoint ? { apiKey, endpoint } : null;
    }
    return envAzureFoundryCredentials();
}

/**
 * Vertex AI credentials for a request; see bedrockCredentials. The key is the
 * service-account JSON, which also names the project.
 */
export async function vertexCredentials(
    apiKeys?: UserApiKeys,
): Promise<VertexCredentials | null> {
    if (isProviderDisabled("vertex", apiKeys)) return null;
    const key = apiKeys?.vertex?.trim();
    if (key) {
        const account = parseVertexServiceAccount(key);
        const location = normalizeVertexLocation(
            apiKeys?.providerSettings?.vertex?.location,
        );
        return account && location ? { ...account, location } : null;
    }
    return envVertexCredentials();
}

/**
 * A user's own OpenAI-compatible endpoint. There is no environment fallback:
 * deployments declare shared endpoints in MIKE_MODEL_CONFIG_JSON instead.
 */
export async function customEndpointCredentials(
    apiKeys?: UserApiKeys,
): Promise<CustomEndpointCredentials | null> {
    if (isProviderDisabled("custom", apiKeys)) return null;
    const apiKey = apiKeys?.custom?.trim();
    const baseUrl = normalizeCustomBaseUrl(
        apiKeys?.providerSettings?.custom?.baseUrl,
    );
    return apiKey ? (baseUrl ? { apiKey, baseUrl } : null) : envCustomEndpointCredentials();
}
