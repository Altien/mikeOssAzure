// Browser-side mirror of backend/src/lib/llm/cloudProviders.ts validation, so
// a malformed region or endpoint is explained before the save round trip.
// The backend remains authoritative and re-validates every value.

const AWS_REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
const AZURE_RESOURCE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const AZURE_ENDPOINT_HOST_SUFFIXES = [
  ".openai.azure.com",
  ".cognitiveservices.azure.com",
  ".services.ai.azure.com",
];

/** "us-east-1" for a valid AWS region code (any case), otherwise null. */
export function normalizeAwsRegion(value: string): string | null {
  const region = value.trim().toLowerCase();
  return AWS_REGION_RE.test(region) ? region : null;
}

/**
 * An Azure OpenAI resource name, or an https endpoint on an Azure AI
 * hostname without a trailing slash; otherwise null.
 */
export function normalizeAzureEndpoint(value: string): string | null {
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
      (suffix) => hostname.endsWith(suffix) && hostname.length > suffix.length,
    )
  ) {
    return null;
  }
  return `https://${hostname}${url.pathname.replace(/\/+$/, "")}`;
}
