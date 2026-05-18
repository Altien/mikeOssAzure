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
// `readSecretEnv()` is the single point where the backend turns that sentinel
// back into an empty string, so the rest of the codebase can treat
// "not configured" as `""` uniformly.

const SECRET_PLACEHOLDER = "__unset__";

export function readSecretEnv(name: string): string {
    const raw = process.env[name];
    if (!raw) return "";
    const trimmed = raw.trim();
    if (trimmed === SECRET_PLACEHOLDER) return "";
    return trimmed;
}
