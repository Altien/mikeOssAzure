import { getKeyVaultConfig } from "./config";
import { createPlatformSupabase, type Db } from "./supabase";
import { freezeTenancyMode } from "./tenancyMode";
import { optionalStampConfig, readStampConfiguration, requiredStampConfig, type StampConfiguration } from "./stampConfiguration";
import { streamRunDatabaseUri } from "./postgresSession";
import { externalIdentityConfiguration } from "./auth/entraConfiguration";
import { getConfiguredModel } from "./llm/registry";
import { probeTenantPostgrestPath } from "./tenantDatabaseProbe";

export interface PlatformCredentialRequirement { tier: string | null; provider: string; model: string }
export interface StampRuntimeMetadata {
  pooled: boolean;
  fallback_tenant_id: string | null;
  stamp_id: string | null;
  region: string | null;
  platform_credentials: PlatformCredentialRequirement[];
}

function requireHttps(raw: string, name: string, origin = false): void {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.hash
    || (origin && (url.pathname !== "/" || url.search))) throw new Error("Invalid " + name);
}

const providerSecrets: Record<string, string[]> = {
  claude: ["anthropic-api-key", "claude-api-key"], gemini: ["gemini-api-key"], openai: ["openai-api-key"],
  kimi: ["moonshot-api-key"], mistral: ["mistral-api-key"], openrouter: ["openrouter-api-key"],
  vercel: ["ai-gateway-api-key", "vercel-ai-gateway-api-key"], "opencode-go": ["opencode-api-key"],
  courtlistener: ["courtlistener-api-token"],
};

/** Same vault-first tier/global order as inference, but outages are not swallowed. */
async function credentialAvailable(names: string[], tier: string | null): Promise<boolean> {
  const candidates = [...(tier ? [("platform-" + tier + "-" + names[0])] : []), ...names];
  for (const name of candidates) {
    if (process.env.KEY_VAULT_NAME) {
      try {
        const value = (await getKeyVaultConfig(name)).trim();
        if (value && value !== "__unset__") return true;
      } catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error; }
    }
    const value = process.env[name.toUpperCase().replaceAll("-", "_")]?.trim();
    if (value && value !== "__unset__") return true;
  }
  return false;
}

async function validatePlatformCredential(requirement: PlatformCredentialRequirement): Promise<void> {
  const { provider, model, tier } = requirement;
  let names = providerSecrets[provider];
  if (provider === "openai-compatible") {
    const configured = getConfiguredModel(model);
    if (!configured) throw new Error("Platform model is missing from registry: " + model);
    if (configured.apiKey) return;
    if (configured.apiKeyProvider) names = providerSecrets[configured.apiKeyProvider];
    else if (configured.apiKeyEnv) names = [configured.apiKeyEnv.toLowerCase().replaceAll("_", "-")];
    else return; // An explicitly configured unauthenticated endpoint is supported.
  }
  if (provider === "azureOpenai") {
    if (await credentialAvailable(["azure-openai-api-key"], tier)
      && await credentialAvailable(["azure-openai-endpoint"], tier)) return;
  } else if (names && await credentialAvailable(names, tier)) return;
  throw new Error("Platform credential unavailable for tier " + (tier || "default") + ", provider " + provider);
}

async function validateCloudConfiguration(config: StampConfiguration, metadata: StampRuntimeMetadata): Promise<void> {
  if (config.provider !== "entra") throw new Error("Pooled production runtime requires Entra authentication");
  if (!process.env.KEY_VAULT_NAME || !process.env.AZURE_CLIENT_ID) throw new Error("Pooled runtime requires Key Vault and managed identity");
  requireHttps(process.env.API_PUBLIC_URL || await requiredStampConfig("backend-public-url"), "backend public URL", true);
  requireHttps(await requiredStampConfig("frontend-url"), "frontend URL", true);
  requireHttps(await requiredStampConfig("word-addin-url"), "Word add-in URL", true);
  requireHttps(await requiredStampConfig("pooled-onboarding-url"), "onboarding URL");
  await externalIdentityConfiguration();
  for (const name of ["altien-entra-client-secret", "entra-client-id", "entra-client-secret", "entra-backend-client-id"]) {
    await requiredStampConfig(name);
  }
  const jwt = await requiredStampConfig("postgrest-jwt-secret");
  if (jwt.length < 32) throw new Error("PostgREST JWT signing secret is too short");
  if (!process.env.SUPABASE_URL) throw new Error("Pooled runtime requires SUPABASE_URL");
  await streamRunDatabaseUri();
  for (const requirement of metadata.platform_credentials) await validatePlatformCredential(requirement);
}

/** Read-only startup gate; successful signed RPC also proves PostgREST connectivity. */
export async function probeStampRuntime(db: Db = createPlatformSupabase()): Promise<StampRuntimeMetadata> {
  const config = await readStampConfiguration();
  const { data, error } = await db.rpc("stamp_runtime_metadata");
  if (error || !data || typeof data !== "object" || Array.isArray(data)) throw new Error("Stamp runtime metadata is unavailable");
  const metadata = data as StampRuntimeMetadata;
  if (typeof metadata.pooled !== "boolean" || metadata.pooled !== (config.mode === "pooled")) {
    throw new Error("Server tenancy mode does not match the deployed database");
  }
  if (config.mode === "pooled") {
    if (metadata.fallback_tenant_id !== null || metadata.stamp_id !== config.stampId || metadata.region !== config.region) {
      throw new Error("Pooled stamp identity or fallback does not match the deployed database");
    }
    if ((await optionalStampConfig("tenant-rls-enforced"))?.toLowerCase() === "false") throw new Error("Pooled runtime requires enforced tenant RLS");
    if (!Array.isArray(metadata.platform_credentials)) throw new Error("Stamp credential metadata is unavailable");
    if (!config.localDevelopment) await validateCloudConfiguration(config, metadata);
  } else if (metadata.fallback_tenant_id !== null && metadata.fallback_tenant_id !== config.fallbackTenantId) {
    throw new Error("Single-install tenant does not match the deployed database");
  }
  // The call above proves service_role only; tenant requests use their own role.
  await probeTenantPostgrestPath();
  freezeTenancyMode(config.mode);
  return metadata;
}
