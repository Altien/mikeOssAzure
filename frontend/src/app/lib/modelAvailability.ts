// The web app's view of key-based model availability. The rules live in the
// catalog shared with the Word add-in (`@mike/client`); the web
// app's ApiKeyState is a ProviderKeyStates.
import {
    isModelAllowedByTenant,
    isModelAvailable as isCatalogModelAvailable,
    isProviderAvailable as isCatalogProviderAvailable,
    type ModelOption,
    type ModelProvider,
    type ProviderKeyStates,
} from "@mike/client";

export {
    getModelProvider,
    modelGroupToProvider,
    providerLabel,
    type ModelProvider,
} from "@mike/client";

/** Provider key states that may also carry a pooled tenant's model allowlist. */
export type TenantKeyStates = {
    readonly [provider: string]:
        | ProviderKeyStates[string]
        | readonly string[]
        | null
        | undefined;
    modelAllowlist?: readonly string[] | null;
};

/** The provider entries alone, for the shared catalog's key-based rules. */
export function providerKeyStates(apiKeys: TenantKeyStates): ProviderKeyStates {
    const { modelAllowlist: _allowlist, ...providers } = apiKeys;
    return providers as ProviderKeyStates;
}

/**
 * Multi-tenant divergence: a pooled tenant's settings may restrict the models
 * its members can use. The backend reports that allowlist on the profile's
 * apiKeyStatus; a model outside it is unavailable whatever keys exist. The
 * backend remains authoritative.
 */
export function isModelAvailable(
    modelId: string,
    apiKeys: TenantKeyStates,
    discoveredModels?: readonly ModelOption[] | readonly string[],
): boolean {
    if (!isModelAllowedByTenant(modelId, apiKeys.modelAllowlist)) return false;
    return isCatalogModelAvailable(modelId, providerKeyStates(apiKeys), discoveredModels);
}

export function isProviderAvailable(
    provider: ModelProvider,
    apiKeys: TenantKeyStates,
): boolean {
    return isCatalogProviderAvailable(provider, providerKeyStates(apiKeys));
}
