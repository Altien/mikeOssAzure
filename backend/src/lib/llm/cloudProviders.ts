// Credentials for the two cloud platforms whose keys only work together with a
// non-secret setting: Amazon Bedrock (an API key scoped to an AWS region) and
// Azure OpenAI (an API key scoped to one Azure resource).
//
// A key and its setting always come from the same source. A user's saved key
// travels with the region/endpoint the user saved next to it; the
// deployment's environment key travels with the environment's
// region/endpoint. Mixing them would send a user's key to the operator's
// Azure resource, or the operator's key to a resource the user chose.

import type { UserApiKeys } from "./types";
import { resolveProviderSecret } from "../envSecrets";

export type BedrockCredentials = { apiKey: string; region: string };
export type AzureCredentials = { apiKey: string; endpoint: string };

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

// Upstream divergence (sync-log: 9c5ffa31): cloud deployment credentials
// resolve every Key Vault alias before environment fallback. Callers await
// this boundary before selecting credentials or constructing an adapter.
export async function envBedrockApiKey(): Promise<string | null> {
    return (await resolveProviderSecret("aws-bearer-token-bedrock", ["bedrock-api-key"])) || null;
}

export async function envBedrockRegion(): Promise<string | null> {
    return normalizeAwsRegion(await resolveProviderSecret("bedrock-aws-region", ["aws-region"]));
}

export async function envAzureApiKey(): Promise<string | null> {
    return (await resolveProviderSecret("azure-api-key", ["azure-openai-api-key"])) || null;
}

export async function envAzureEndpoint(): Promise<string | null> {
    return normalizeAzureEndpoint(await resolveProviderSecret("azure-openai-endpoint", ["azure-resource-name"]));
}

/** The deployment's own Bedrock credentials, when both halves are set. */
export async function envBedrockCredentials(): Promise<BedrockCredentials | null> {
    const [apiKey, region] = await Promise.all([envBedrockApiKey(), envBedrockRegion()]);
    return apiKey && region ? { apiKey, region } : null;
}

/** The deployment's own Azure OpenAI credentials, when both halves are set. */
export async function envAzureCredentials(): Promise<AzureCredentials | null> {
    const [apiKey, endpoint] = await Promise.all([envAzureApiKey(), envAzureEndpoint()]);
    return apiKey && endpoint ? { apiKey, endpoint } : null;
}

/**
 * Bedrock credentials for a request. A key in `apiKeys` must arrive with its
 * region; a key without one is unusable rather than paired with the
 * environment's region.
 */
export async function bedrockCredentials(
    apiKeys?: UserApiKeys,
): Promise<BedrockCredentials | null> {
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
    const apiKey = apiKeys?.azure?.trim();
    if (apiKey) {
        const endpoint = normalizeAzureEndpoint(
            apiKeys?.providerSettings?.azure?.endpoint,
        );
        return endpoint ? { apiKey, endpoint } : null;
    }
    // Keep Dev's encrypted Azure compound usable at this boundary; the
    // existing aoai: Chat Completions adapter retains its own protocol.
    const legacy = apiKeys?.azureOpenai;
    if (legacy?.apiKey) {
        const endpoint = normalizeAzureEndpoint(legacy.endpoint);
        return endpoint ? { apiKey: legacy.apiKey, endpoint } : null;
    }
    return envAzureCredentials();
}
