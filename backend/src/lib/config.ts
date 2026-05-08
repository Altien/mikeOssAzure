// Deployment-wide config reader, backed by Key Vault with an env-var
// override and a TTL'd in-process cache.
//
// Lookup order for getConfig("some-secret"):
//   1. process.env.SOME_SECRET (uppercased, hyphens → underscores) —
//      keeps local dev unchanged AND covers the transition period
//      while existing Container App env vars still secret-ref into KV.
//   2. In-process cache, if entry is fresher than CONFIG_CACHE_TTL.
//   3. Live KV read via the Container App's UAMI (DefaultAzureCredential
//      picks the right MI from AZURE_CLIENT_ID).
//
// flushConfigCache() invalidates every entry — called by /install after
// writing a new value, so the next request picks up the change without
// waiting for the TTL or restarting the revision.

import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

type CacheEntry = {
    value: string;
    fetchedAt: number;
};

const TTL_MS = (() => {
    const raw = process.env.CONFIG_CACHE_TTL_SECONDS;
    if (raw === undefined) return 5 * 60 * 1000;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 0) return 5 * 60 * 1000;
    return parsed * 1000;
})();

const cache = new Map<string, CacheEntry>();

let secretClient: SecretClient | null = null;
function getSecretClient(): SecretClient {
    if (secretClient) return secretClient;
    const name = process.env.KEY_VAULT_NAME;
    if (!name) {
        throw new Error(
            "KEY_VAULT_NAME env var is required for KV-backed config",
        );
    }
    secretClient = new SecretClient(
        `https://${name}.vault.azure.net/`,
        new DefaultAzureCredential(),
    );
    return secretClient;
}

export async function getConfig(secretName: string): Promise<string> {
    const envKey = secretName.toUpperCase().replaceAll("-", "_");
    const fromEnv = process.env[envKey];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;

    const now = Date.now();
    const cached = cache.get(secretName);
    if (cached && now - cached.fetchedAt < TTL_MS) {
        return cached.value;
    }

    const client = getSecretClient();
    const secret = await client.getSecret(secretName);
    const value = secret.value ?? "";
    cache.set(secretName, { value, fetchedAt: now });
    return value;
}

export function flushConfigCache(): void {
    cache.clear();
}

// Write `value` to the named KV secret AND invalidate the cache so the
// next getConfig() call sees the new value (subject to env-override
// priority).
//
// Returns the secret's id (URL with version) so the caller can show
// the operator what was written.
export async function setConfig(
    secretName: string,
    value: string,
): Promise<string> {
    const client = getSecretClient();
    const result = await client.setSecret(secretName, value);
    cache.delete(secretName);
    return result.properties.id ?? "";
}
