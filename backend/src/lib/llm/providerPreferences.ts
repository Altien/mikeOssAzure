import type { UserApiKeys } from "./types";

const AZURE_PROVIDER_ALIASES = ["azure", "azure_openai", "azureOpenai"] as const;

/** One Azure credential family spans router, persisted and legacy dispatch names. */
export function isProviderDisabled(provider: string | undefined, apiKeys?: UserApiKeys): boolean {
    if (!provider) return false;
    const disabled = apiKeys?.disabledProviders ?? [];
    if ((AZURE_PROVIDER_ALIASES as readonly string[]).includes(provider)) {
        return AZURE_PROVIDER_ALIASES.some(alias => disabled.includes(alias));
    }
    return disabled.includes(provider);
}
