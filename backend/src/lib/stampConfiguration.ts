import { getConfig } from "./config";
import { getTenancyMode, type TenancyMode } from "./tenancyMode";

/** Optional means absent, never an operational Key Vault failure. */
export async function optionalStampConfig(name: string): Promise<string | undefined> {
  const fromEnv = process.env[name.toUpperCase().replaceAll("-", "_")]?.trim();
  if (!fromEnv && !process.env.KEY_VAULT_NAME) return undefined;
  if (fromEnv === "__unset__" && !process.env.KEY_VAULT_NAME) return undefined;
  try {
    const value = (await getConfig(name)).trim();
    return value && value !== "__unset__" ? value : undefined;
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return undefined;
    throw error;
  }
}

export async function requiredStampConfig(name: string): Promise<string> {
  const value = await optionalStampConfig(name);
  if (!value) throw new Error("Stamp runtime requires " + name);
  return value;
}

export interface StampConfiguration {
  mode: TenancyMode;
  provider: string;
  localDevelopment: boolean;
  stampId?: string;
  region?: string;
  fallbackTenantId: string | null;
}

export async function readStampConfiguration(): Promise<StampConfiguration> {
  const mode = await getTenancyMode();
  const provider = ((await optionalStampConfig("auth-provider")) || "supabase").toLowerCase();
  const stampId = await optionalStampConfig("stamp-id");
  const region = await optionalStampConfig("stamp-region");
  if (stampId && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(stampId)) throw new Error("Invalid stamp-id");
  if (region && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(region)) throw new Error("Invalid stamp-region");
  if (mode === "pooled" && (!stampId || !region)) throw new Error("Pooled runtime requires stamp-id and stamp-region");
  const fallbackTenantId = mode === "pooled" ? null : provider === "entra"
    ? await requiredStampConfig("entra-tenant-id")
    : (await optionalStampConfig("default-tenant-id")) || "default";
  return { mode, provider, stampId, region, fallbackTenantId,
    localDevelopment: process.env.NODE_ENV !== "production" && provider === "local" };
}
