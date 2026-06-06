// Per-user encrypted provider-key storage. Adapted from upstream
// ba6f7711449de47bd25cad7ac21bdc2a53355963's `backend/src/lib/userApiKeys.ts`.
//
// Differences from upstream:
//
//   1. Encryption secret comes from Azure Key Vault (via `getConfig()`),
//      not from `process.env.SUPABASE_SECRET_KEY` or similar fallbacks.
//      `getConfig()` handles env-var override for local dev / tests so
//      the secret can still be set inline when there's no KV reachable.
//
//   2. Provider set is dev's full set: `claude | gemini | openai |
//      azure_openai` (upstream supports only the first two). The
//      `azure_openai` row's plaintext is a JSON-encoded
//      `{endpoint, key, version, deployment}` object; for other providers
//      the plaintext is the raw key string.
//
//   3. Read path falls back to `user_profiles` plaintext columns when a
//      provider has no row in `user_api_keys`. This covers the migration
//      window between `0006_user_api_keys.sql` (table created) and the
//      one-shot `migrate-user-api-keys.ts` script populating it. The
//      fallback goes away once `0007_drop_legacy_provider_keys.sql`
//      lands; remove the function then.

import crypto from "node:crypto";
import { getConfig } from "./config";
import { resolveSecret } from "./envSecrets";
import { createServerSupabase } from "./supabase";
import type { AzureOpenaiSettings, UserApiKeys } from "./llm";

// `openrouter` and `courtlistener` added with upstream 44e868e
// (CourtListener integration). Unlike upstream, their org-level
// fallback goes through resolveSecret() (Key Vault primary, env var
// fallback — internal design notes §2.4) instead of raw process.env.
export type ApiKeyProvider =
    | "claude"
    | "gemini"
    | "openai"
    | "openrouter"
    | "courtlistener"
    | "azure_openai";

const ENCRYPTION_SECRET_NAME = "user-api-keys-encryption-key";

let keyPromise: Promise<Buffer> | null = null;

async function getEncryptionKey(): Promise<Buffer> {
    if (!keyPromise) {
        keyPromise = (async () => {
            const secret = await getConfig(ENCRYPTION_SECRET_NAME);
            if (!secret) {
                throw new Error(
                    `User API keys encryption secret (${ENCRYPTION_SECRET_NAME}) ` +
                        `is not configured. Set the secret in Key Vault (canonical), ` +
                        `or the equivalent env var USER_API_KEYS_ENCRYPTION_KEY for local dev.`,
                );
            }
            // SHA-256 of the input yields a deterministic 32-byte key,
            // matching the AES-256-GCM key size. Matches upstream's
            // shape so a secret rotated between forks decrypts the same.
            return crypto.createHash("sha256").update(secret).digest();
        })();
    }
    return keyPromise;
}

/**
 * Force a re-fetch of the encryption secret on the next encrypt/decrypt
 * call. Use after rotating the KV secret.
 */
export function flushEncryptionKey(): void {
    keyPromise = null;
}

type EncryptedPayload = {
    encrypted_key: string;
    iv: string;
    auth_tag: string;
};

async function encrypt(plaintext: string): Promise<EncryptedPayload> {
    const key = await getEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
    ]);
    return {
        encrypted_key: encrypted.toString("base64"),
        iv: iv.toString("base64"),
        auth_tag: cipher.getAuthTag().toString("base64"),
    };
}

async function decrypt(payload: EncryptedPayload): Promise<string> {
    const key = await getEncryptionKey();
    const iv = Buffer.from(payload.iv, "base64");
    const ciphertext = Buffer.from(payload.encrypted_key, "base64");
    const authTag = Buffer.from(payload.auth_tag, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
    ]);
    return plaintext.toString("utf8");
}

type StoredRow = {
    provider: ApiKeyProvider;
    encrypted_key: string;
    iv: string;
    auth_tag: string;
};

type AzureOpenaiBlob = {
    endpoint: string;
    key: string | null;
    version: string | null;
    deployment: string;
};

function parseAzureOpenaiBlob(plaintext: string): AzureOpenaiSettings | null {
    try {
        const parsed = JSON.parse(plaintext) as Partial<AzureOpenaiBlob>;
        if (!parsed.endpoint || !parsed.deployment) return null;
        return {
            endpoint: parsed.endpoint,
            deployment: parsed.deployment,
            apiKey: parsed.key ?? null,
            apiVersion: parsed.version ?? null,
        };
    } catch (err) {
        console.error("[userApiKeys] failed to parse azure_openai blob", err);
        return null;
    }
}

function serializeAzureOpenaiBlob(settings: AzureOpenaiSettings): string {
    const blob: AzureOpenaiBlob = {
        endpoint: settings.endpoint,
        key: settings.apiKey ?? null,
        version: settings.apiVersion ?? null,
        deployment: settings.deployment,
    };
    return JSON.stringify(blob);
}

/**
 * Read all of a user's provider keys, returning the shape the rest of
 * the backend expects (`UserApiKeys` from `./llm`). Decrypts each row
 * at the application layer.
 *
 * During the migration window (after `0006_user_api_keys.sql` lands but
 * before `migrate-user-api-keys.ts` has emptied the legacy columns),
 * providers with no encrypted row fall back to the plaintext columns on
 * `user_profiles`. The fallback is removed when `0007_drop_legacy_provider_keys.sql`
 * lands.
 */
export async function getUserApiKeys(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserApiKeys> {
    const client = db ?? createServerSupabase();

    const { data: rows, error } = await client
        .from("user_api_keys")
        .select("provider, encrypted_key, iv, auth_tag")
        .eq("user_id", userId);
    if (error) {
        console.error("[userApiKeys] failed to read user_api_keys", {
            userId,
            error: error.message,
        });
        // Fall through to the legacy-column fallback so we don't hard-fail
        // during transitional states.
    }

    const decrypted: Partial<Record<ApiKeyProvider, string>> = {};
    for (const row of (rows ?? []) as StoredRow[]) {
        try {
            decrypted[row.provider] = await decrypt(row);
        } catch (err) {
            console.error("[userApiKeys] decryption failed", {
                userId,
                provider: row.provider,
                err: err instanceof Error ? err.message : String(err),
            });
            // Skip the row — the caller will see "no key" and act
            // accordingly. Better than crashing the whole request.
        }
    }

    const haveAny = Object.keys(decrypted).length > 0;
    const legacy = haveAny
        ? null
        : await readLegacyProviderKeys(userId, client);

    // openrouter / courtlistener (44e868e): no legacy user_profiles
    // columns to fall back to — instead fall back to the org-level
    // secret (KV primary, env fallback: OPENROUTER_API_KEY /
    // COURTLISTENER_API_TOKEN — same env names upstream reads directly).
    const openrouter =
        decrypted.openrouter ??
        (await resolveSecret("openrouter-api-key")) ??
        null;
    const courtlistener =
        decrypted.courtlistener ??
        (await resolveSecret("courtlistener-api-token")) ??
        null;

    return {
        claude: decrypted.claude ?? legacy?.claude ?? null,
        gemini: decrypted.gemini ?? legacy?.gemini ?? null,
        openai: decrypted.openai ?? legacy?.openai ?? null,
        openrouter: openrouter || null,
        courtlistener: courtlistener || null,
        azureOpenai: decrypted.azure_openai
            ? parseAzureOpenaiBlob(decrypted.azure_openai)
            : (legacy?.azureOpenai ?? null),
    };
}

/**
 * Set / update a user's key for one provider. Encrypts at the
 * application layer; the DB only ever sees ciphertext.
 *
 * For `azure_openai`, pass the structured settings; this function
 * serialises and encrypts the whole blob.
 */
export async function setUserApiKey(
    userId: string,
    provider: ApiKeyProvider,
    plaintext: string | AzureOpenaiSettings,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<void> {
    const client = db ?? createServerSupabase();
    const serialized =
        provider === "azure_openai" && typeof plaintext !== "string"
            ? serializeAzureOpenaiBlob(plaintext)
            : typeof plaintext === "string"
              ? plaintext
              : null;
    if (serialized === null) {
        throw new Error(
            `setUserApiKey called with wrong plaintext shape for provider ${provider}`,
        );
    }
    const payload = await encrypt(serialized);
    const { error } = await client.from("user_api_keys").upsert(
        {
            user_id: userId,
            provider,
            encrypted_key: payload.encrypted_key,
            iv: payload.iv,
            auth_tag: payload.auth_tag,
            updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,provider" },
    );
    if (error) {
        throw new Error(
            `Failed to set user_api_keys row for ${provider}: ${error.message}`,
        );
    }
}

/**
 * Delete a user's row for one provider (e.g., user clears their key
 * from the UI).
 */
export async function deleteUserApiKey(
    userId: string,
    provider: ApiKeyProvider,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<void> {
    const client = db ?? createServerSupabase();
    const { error } = await client
        .from("user_api_keys")
        .delete()
        .eq("user_id", userId)
        .eq("provider", provider);
    if (error) {
        throw new Error(
            `Failed to delete user_api_keys row for ${provider}: ${error.message}`,
        );
    }
}

/**
 * Return which providers a user has configured (without decrypting any
 * values). Used by `routes/user.ts` GET to give the client a
 * `{configured: bool}` per provider without leaking plaintext keys.
 */
export async function getConfiguredProviders(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<Record<ApiKeyProvider, boolean>> {
    const client = db ?? createServerSupabase();
    const { data: rows } = await client
        .from("user_api_keys")
        .select("provider")
        .eq("user_id", userId);
    const configured: Record<ApiKeyProvider, boolean> = {
        claude: false,
        gemini: false,
        openai: false,
        openrouter: false,
        courtlistener: false,
        azure_openai: false,
    };
    for (const row of (rows ?? []) as { provider: ApiKeyProvider }[]) {
        configured[row.provider] = true;
    }
    // Legacy fallback: if a provider isn't in user_api_keys but the
    // plaintext column on user_profiles is non-null, it counts as
    // configured. Remove once 0007 lands.
    if (Object.values(configured).every((v) => !v)) {
        const legacy = await readLegacyProviderKeys(userId, client);
        if (legacy) {
            if (legacy.claude) configured.claude = true;
            if (legacy.gemini) configured.gemini = true;
            if (legacy.openai) configured.openai = true;
            if (legacy.azureOpenai) configured.azure_openai = true;
        }
    }
    return configured;
}

// ─── Legacy fallback (TEMPORARY — remove with 0007) ────────────────────────

type LegacyRow = {
    claude_api_key: string | null;
    gemini_api_key: string | null;
    openai_api_key: string | null;
    azure_openai_endpoint: string | null;
    azure_openai_api_key: string | null;
    azure_openai_api_version: string | null;
    azure_openai_deployment: string | null;
};

/**
 * Read provider keys directly from `user_profiles` plaintext columns.
 * Used as a fallback during the migration window. Remove once
 * `0007_drop_legacy_provider_keys.sql` has landed.
 */
async function readLegacyProviderKeys(
    userId: string,
    client: ReturnType<typeof createServerSupabase>,
): Promise<UserApiKeys | null> {
    const { data } = await client
        .from("user_profiles")
        .select(
            "claude_api_key, gemini_api_key, openai_api_key, azure_openai_endpoint, azure_openai_api_key, azure_openai_api_version, azure_openai_deployment",
        )
        .eq("user_id", userId)
        .maybeSingle();
    if (!data) return null;
    const row = data as LegacyRow;
    return {
        claude: row.claude_api_key ?? null,
        gemini: row.gemini_api_key ?? null,
        openai: row.openai_api_key ?? null,
        azureOpenai:
            row.azure_openai_endpoint && row.azure_openai_deployment
                ? {
                      endpoint: row.azure_openai_endpoint,
                      deployment: row.azure_openai_deployment,
                      apiKey: row.azure_openai_api_key,
                      apiVersion: row.azure_openai_api_version,
                  }
                : null,
    };
}

/**
 * Read the full legacy row (for the migration script). Returns null if
 * there's nothing worth migrating. Internal-ish: only the migration
 * script and `getUserApiKeys`'s fallback should call this.
 */
export async function _readLegacyRowForMigration(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<LegacyRow | null> {
    const client = db ?? createServerSupabase();
    const { data } = await client
        .from("user_profiles")
        .select(
            "claude_api_key, gemini_api_key, openai_api_key, azure_openai_endpoint, azure_openai_api_key, azure_openai_api_version, azure_openai_deployment",
        )
        .eq("user_id", userId)
        .maybeSingle();
    return (data as LegacyRow | null) ?? null;
}
