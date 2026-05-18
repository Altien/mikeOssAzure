// Backend helper for reading Container-App secretRef'd env vars whose source
// KV secret may not yet have a real value.
//
// Bicep (infra/modules/keyvault.bicep) seeds AI-provider KV secrets with a
// '__unset__' sentinel on first deploy because:
//   - Azure rejects Container App revisions if a referenced KV secret is
//     missing, so the secret must exist from the first provision.
//   - KV rejects zero-length secret values.
//   - ARM-TTK rejects whitespace-only literals in marketplace packages
//     ("Template Should Not Contain Blanks"), so a single-space placeholder
//     is not viable either.
//
// `readSecretEnv()` is the synchronous point where the backend turns that
// sentinel back into an empty string for code that runs OUTSIDE async
// contexts. The async `resolveSecret()` below is the preferred entry
// point for new code — it covers both the env-var path AND the KV
// fallback for secrets the install configurator writes directly (e.g.
// gemini-api-key, azure-openai-*) where Bicep has no secretRef wiring.

import { getConfig } from "./config.js";

const SECRET_PLACEHOLDER = "__unset__";

export function readSecretEnv(name: string): string {
    const raw = process.env[name];
    if (!raw) return "";
    const trimmed = raw.trim();
    if (trimmed === SECRET_PLACEHOLDER) return "";
    return trimmed;
}

// Resolve a secret uniformly across the two paths a marketplace install
// can populate:
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
    const raw = await getConfig(kvSecretName).catch(() => "");
    const trimmed = raw.trim();
    if (!trimmed || trimmed === SECRET_PLACEHOLDER) return "";
    return trimmed;
}
