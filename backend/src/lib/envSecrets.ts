// Backend helper for reading Container-App secretRef'd env vars whose source
// KV secret may not yet have a real value.
//
// Bicep (infra/modules/keyvault.bicep) seeds AI-provider KV secrets with a
// '__unset__' sentinel on first deploy because:
//   - Azure rejects Container App revisions if a referenced KV secret is
//     missing, so the secret must exist from the first provision.
//   - KV rejects zero-length secret values.
//   - Deployment validators reject whitespace-only literals, so a
//     single-space placeholder is not viable either.
//
// `readSecretEnv()` is the synchronous point where the backend turns that
// sentinel back into an empty string for code that runs OUTSIDE async
// contexts. The async `resolveSecret()` below is the preferred entry
// point for new code — it covers both the env-var path AND the KV
// fallback for secrets the install configurator writes directly (e.g.
// gemini-api-key, azure-openai-*) where Bicep has no secretRef wiring.

import { getKeyVaultConfig } from "./config.js";
import { isSecretNotFound } from "./secretNotFound";
import { getTenantConfig, resolveTenantSecret } from "./tenantSettings";

const PROVIDER_SECRETS = new Set([
    "anthropic-api-key", "claude-api-key", "gemini-api-key", "openai-api-key",
    "moonshot-api-key", "mistral-api-key", "openrouter-api-key", "opencode-api-key",
    "ai-gateway-api-key", "vercel-ai-gateway-api-key", "courtlistener-api-token",
    "azure-openai-endpoint", "azure-openai-api-key",
    // Main's cloud providers (cloudProviders.ts) and xAI: a BYO tenant must not
    // fall back to the platform's credentials for them either.
    "aws-bearer-token-bedrock", "bedrock-aws-region", "azure-foundry-api-key",
    "azure-foundry-endpoint", "google-vertex-credentials-json", "google-vertex-location",
    "custom-api-key", "custom-base-url", "xai-api-key",
    // Main's web-search backends (webSearch/credentials.ts).
    "brave-search-api-key", "tavily-api-key", "deepseek-search-api-key",
    // Administrator-entered providers (llm/managedProviders.ts): a BYO tenant
    // must not reach the platform's key, address or model list either.
    "tokenjuice-api-key", "tokenjuice-base-url", "tokenjuice-models",
    "meta-api-key", "meta-base-url", "meta-models",
]);

const SECRET_PLACEHOLDER = "__unset__";

export function readSecretEnv(name: string): string {
    const raw = process.env[name];
    if (!raw) return "";
    const trimmed = raw.trim();
    if (trimmed === SECRET_PLACEHOLDER) return "";
    return trimmed;
}

// Resolve a secret uniformly across the two supported configuration paths:
//   - Container App env (Bicep secretRef → KV at revision boot).
//   - KV directly (install configurator's in-app form writes).
//
// getConfig() already does env-first then KV, so this just adds the
// __unset__ filter + a fail-closed catch on KV-not-found. Returns "" if
// neither source provided a usable value.
//
// Async to cover the KV branch — providers that call this must be invoked
// from async contexts (true for all chat / LLM entry points today).
// Closes 040 Entry 12.
export async function resolveSecret(kvSecretName: string): Promise<string> {
    return resolveTenantSecret(kvSecretName, async () => {
        const raw = await getTenantConfig(kvSecretName).catch(() => "");
        const trimmed = raw.trim();
        if (!trimmed || trimmed === SECRET_PLACEHOLDER) return "";
        return trimmed;
    }, { provider: PROVIDER_SECRETS.has(kvSecretName) });
}

// New router credentials use Key Vault as the source of truth. Check every
// vault alias before falling back to revision environment or local settings.
// Existing getConfig/resolveSecret callers retain their env-first semantics.
//
// A failed vault read is treated as absent. A caller that would substitute a
// default for an absent value passes `failOnUnreadable`, which throws on any
// failure other than a confirmed absence.
export async function resolveProviderSecret(
    name: string,
    aliases: string[] = [],
    { failOnUnreadable = false }: { failOnUnreadable?: boolean } = {},
): Promise<string> {
    // An operator override name (e.g. BRAVE_SEARCH_API_KEY_SECRET_NAME) comes
    // first with the canonical name as an alias; either marks a provider key.
    const provider = [name, ...aliases].some((secretName) => PROVIDER_SECRETS.has(secretName));
    return resolveTenantSecret(name, async () => {
        const names = [name, ...aliases];
        if (process.env.KEY_VAULT_NAME) {
            for (const secretName of names) {
                const raw = await getKeyVaultConfig(secretName).catch((error: unknown) => {
                    if (failOnUnreadable && !isSecretNotFound(error)) throw error;
                    return "";
                });
                const value = raw.trim();
                if (value && value !== SECRET_PLACEHOLDER) return value;
            }
        }
        for (const secretName of names) {
            const value = readSecretEnv(secretName.toUpperCase().replaceAll("-", "_"));
            if (value) return value;
        }
        return "";
    }, { provider, aliases, failOnUnreadable });
}

export async function resolveVercelApiKey(): Promise<string> {
    return resolveProviderSecret("ai-gateway-api-key", ["vercel-ai-gateway-api-key"]);
}
