// Tenant configuration (014). The ambient validated request/job tenant owns
// the lookup and cache key. Missing rows preserve single-tenant behaviour;
// read failures fail closed, so an outage cannot bypass an allowlist/BYO mode.
import { getConfig, getKeyVaultConfig } from "./config";
import { currentTenant } from "./tenantContext";
import { createServerSupabase } from "./supabase";
import { isSecretNotFound } from "./secretNotFound";

export type TenantKeyMode = "platform" | "byo" | "hybrid";
export type TenantSettings = {
  key_mode: TenantKeyMode;
  tier: string | null;
  model_allowlist: string[] | null;
  /** Models a member may run on their own provider key; null or [] permits none. */
  member_key_models?: string[] | null;
  enabled_connectors: string[] | null;
  feature_flags: Record<string, boolean>;
  config: Record<string, string>;
  secret_refs: Record<string, string>;
};
const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; value: Promise<TenantSettings | null> }>();

export async function getTenantSettings(): Promise<TenantSettings | null> {
  const tenantId = currentTenant()?.tenantId;
  if (!tenantId) return null; // /install, startup and platform work retain install config.
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = (async () => {
    const { data, error } = await createServerSupabase().from("tenant_settings")
      .select("key_mode, tier, model_allowlist, member_key_models, enabled_connectors, feature_flags, config, secret_refs")
      .eq("tenant_id", tenantId).maybeSingle();
    if (error) throw new Error("Unable to read tenant configuration");
    return data as TenantSettings | null;
  })();
  const entry = { at: Date.now(), value };
  cache.set(tenantId, entry);
  void value.catch(() => { if (cache.get(tenantId) === entry) cache.delete(tenantId); });
  return value;
}

/** Control-plane invalidation hook and test seam. */
export function flushTenantSettingsCache(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId); else cache.clear();
}

/** Non-secret tenant override, then the existing install config abstraction. */
export async function getTenantConfig(key: string): Promise<string> {
  const settings = await getTenantSettings();
  const typed: Record<string, unknown> = settings ? {
    "key-mode": settings.key_mode, tier: settings.tier,
    "model-allowlist": settings.model_allowlist,
    "enabled-connectors": settings.enabled_connectors,
    "feature-flags": settings.feature_flags,
  } : {};
  const value = typed[key] ?? settings?.config?.[key];
  return value !== undefined && value !== null
    ? typeof value === "string" ? value : JSON.stringify(value)
    : getConfig(key);
}

export async function tenantModelAllowlist(): Promise<readonly string[] | null> {
  return (await getTenantSettings())?.model_allowlist ?? null;
}

export async function filterTenantModels<T>(models: readonly T[], id: (model: T) => string): Promise<T[]> {
  const allowed = await tenantModelAllowlist();
  return allowed === null ? [...models] : models.filter((model) => allowed.includes(id(model)));
}

export async function assertTenantModelAllowed(model: string): Promise<void> {
  const allowed = await tenantModelAllowlist();
  if (allowed !== null && !allowed.includes(model)) throw new Error("This model is not enabled for your organisation. Ask an administrator to update the model policy.");
}

/**
 * Each model provider's Key Vault secrets (canonical names and aliases), by
 * settings provider name. In hybrid mode a reference to any one of them makes
 * the whole provider the tenant's, so a tenant endpoint is never paired with
 * the platform's key, nor the reverse.
 */
const PROVIDER_SECRET_GROUPS: Record<string, readonly string[]> = {
  claude: ["anthropic-api-key", "claude-api-key"],
  gemini: ["gemini-api-key"],
  openai: ["openai-api-key"],
  mistral: ["mistral-api-key"],
  kimi: ["moonshot-api-key"],
  xai: ["xai-api-key"],
  openrouter: ["openrouter-api-key"],
  vercel: ["ai-gateway-api-key", "vercel-ai-gateway-api-key"],
  "opencode-go": ["opencode-api-key"],
  bedrock: ["aws-bearer-token-bedrock", "bedrock-aws-region"],
  azure: ["azure-openai-api-key", "azure-openai-endpoint"],
  azure_openai: ["azure-openai-api-key", "azure-openai-endpoint"],
  "azure-foundry": ["azure-foundry-api-key", "azure-foundry-endpoint"],
  vertex: ["google-vertex-credentials-json", "google-vertex-location"],
  custom: ["custom-api-key", "custom-base-url"],
  tokenjuice: ["tokenjuice-api-key", "tokenjuice-base-url", "tokenjuice-models"],
  meta: ["meta-api-key", "meta-base-url", "meta-models"],
};

function hasProviderRef(settings: TenantSettings | null, provider: string): boolean {
  const names = PROVIDER_SECRET_GROUPS[provider === "azureOpenai" ? "azure_openai" : provider] ?? [];
  return names.some((name) => Object.hasOwn(settings?.secret_refs ?? {}, name));
}

/** An organisation key is in place: byo or hybrid with a reference for this provider. */
export async function tenantHasProviderKey(provider: string): Promise<boolean> {
  const settings = await getTenantSettings();
  return (settings?.key_mode === "byo" || settings?.key_mode === "hybrid") && hasProviderRef(settings, provider);
}

/** The tenant, not the platform, supplies this provider's calls (byo, or hybrid with a reference). */
export async function tenantSuppliesProvider(provider: string): Promise<boolean> {
  const settings = await getTenantSettings();
  return settings?.key_mode === "byo" || (settings?.key_mode === "hybrid" && hasProviderRef(settings, provider));
}

function usable(raw: string): string {
  const value = raw.trim();
  return value === "__unset__" ? "" : value;
}

/** Prevent connector fallback from replacing an explicitly configured client. */
export async function hasTenantSecretReference(...names: string[]): Promise<boolean> {
  const refs = (await getTenantSettings())?.secret_refs ?? {};
  return names.some((name) => Object.hasOwn(refs, name));
}

/**
 * Explicit refs never fall through to platform secrets. BYO provider calls
 * also fail closed when a ref is absent; hybrid provider calls use a ref when
 * the provider has one and the platform secret otherwise; connector clients inherit install
 * defaults independently of the LLM key mode. Only names live in Postgres.
 *
 * A failed vault read reads as absent, unless `failOnUnreadable` asks for it to
 * throw: a caller with a default must not take a read failure for "not set".
 */
export async function resolveTenantSecret(
  name: string,
  fallback: () => Promise<string>,
  options: { provider?: boolean; aliases?: string[]; failOnUnreadable?: boolean } = {},
): Promise<string> {
  const readVault = (secretName: string) => getKeyVaultConfig(secretName).catch((error: unknown) => {
    if (options.failOnUnreadable && !isSecretNotFound(error)) throw error;
    return "";
  });
  const settings = await getTenantSettings();
  const names = [name, ...(options.aliases ?? [])];
  const ref = options.provider && settings?.key_mode !== "byo" && settings?.key_mode !== "hybrid" ? undefined
    : names.map((key) => settings?.secret_refs?.[key]).find((value) => value !== undefined);
  if (ref !== undefined) {
    const prefix = `tenant-${currentTenant()!.tenantId}-`;
    if (!/^[a-zA-Z][a-zA-Z0-9-]{0,126}$/.test(ref) || !ref.startsWith(prefix)) throw new Error("Invalid tenant credential reference");
    return usable(await readVault(ref));
  }
  // A partially configured tenant OAuth client must not combine its client ID
  // with the platform client secret (or silently select another client).
  const oauthClient = /^(.*-oauth-client)-(id|secret)$/.exec(name);
  if (oauthClient && Object.keys(settings?.secret_refs ?? {}).some((key) => key.startsWith(oauthClient[1] + "-"))) return "";
  if (options.provider && settings?.key_mode === "byo") return "";
  // Hybrid: a provider the tenant supplies in part never takes the rest from the platform.
  if (options.provider && settings?.key_mode === "hybrid" && Object.entries(PROVIDER_SECRET_GROUPS)
    .some(([provider, group]) => group.some((key) => names.includes(key)) && hasProviderRef(settings, provider))) return "";
  if (options.provider && settings?.tier) {
    const tierName = `platform-${settings.tier}-${name}`;
    if (process.env.KEY_VAULT_NAME) {
      const value = usable(await readVault(tierName));
      if (value) return value;
    }
    const value = usable(process.env[tierName.toUpperCase().replaceAll("-", "_")] ?? "");
    if (value) return value;
  }
  return fallback();
}
