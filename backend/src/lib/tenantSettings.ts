// Tenant configuration (014). The ambient validated request/job tenant owns
// the lookup and cache key. Missing rows preserve single-tenant behaviour;
// read failures fail closed, so an outage cannot bypass an allowlist/BYO mode.
import { getConfig, getKeyVaultConfig } from "./config";
import { currentTenant } from "./tenantContext";
import { createServerSupabase } from "./supabase";
import { isSecretNotFound } from "./secretNotFound";

export type TenantSettings = {
  key_mode: "platform" | "byo";
  tier: string | null;
  model_allowlist: string[] | null;
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
      .select("key_mode, tier, model_allowlist, enabled_connectors, feature_flags, config, secret_refs")
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

export async function tenantKeyMode(): Promise<"platform" | "byo"> {
  return (await getTenantSettings())?.key_mode ?? "platform";
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
 * also fail closed when a ref is absent; connector clients inherit install
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
  const ref = options.provider && settings?.key_mode !== "byo" ? undefined
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
