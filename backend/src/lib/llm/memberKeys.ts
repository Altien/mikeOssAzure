// Member keys (pooled tenants): a member's own provider key, used only for the
// models the tenant's administrators list in tenant_settings.member_key_models.
import { getTenantSettings } from "../tenantSettings";
import { providerForModel } from "./models";
import type { UserApiKeys } from "./types";

/** Providers that take a single API key: the only ones a member may supply. */
export const MEMBER_KEY_PROVIDERS = [
  "claude", "gemini", "openai", "mistral", "kimi", "xai", "openrouter", "vercel", "opencode-go",
] as const;

function providerOf(model: string): string | null {
  try {
    return providerForModel(model);
  } catch {
    return null;
  }
}

/** The listed models a member may run on their own key for this provider. */
export async function memberKeyModels(provider: string): Promise<string[]> {
  if (!(MEMBER_KEY_PROVIDERS as readonly string[]).includes(provider)) return [];
  return ((await getTenantSettings())?.member_key_models ?? []).filter((model) => providerOf(model) === provider);
}

/**
 * The keys for one tenant call: the member's own key when the model is listed
 * and they saved one for its provider; otherwise none, so the tenant's or the
 * platform's key applies. A model that is not listed never gets a member key.
 */
export async function memberApiKeysFor(model: string, apiKeys?: UserApiKeys): Promise<UserApiKeys | undefined> {
  const provider = providerOf(model);
  const key = provider ? apiKeys?.memberKeys?.[provider]?.trim() : undefined;
  if (!provider || !key || !(await memberKeyModels(provider)).includes(model)) return undefined;
  return { [provider]: key } as UserApiKeys;
}
