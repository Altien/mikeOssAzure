// Personal settings adapters over the shared owner-aware credential capability.
import type { Db } from "../../lib/supabase";
import type { ServiceResult } from "../../lib/serviceResult";
import {
    ApiKeyEncryptionUnavailableError,
    deleteUserApiKey,
    getUserApiKeyStatus,
    memberKeyAllowed,
    setApiKeyEnabledFor,
    setUserApiKey,
    userKeyOwner,
    type ApiKeyProvider,
    type ApiKeyStatus,
    type SaveApiKeyResult,
} from "../../lib/providerCredentials/index";
import { getTenancyMode } from "../../lib/tenancyMode";

export function getApiKeyStatus(db: Db, userId: string) {
    return getUserApiKeyStatus(userId, db);
}

export async function saveApiKey(
    db: Db,
    params: { userId: string; provider: ApiKeyProvider; apiKey: string | null; settings?: unknown },
): Promise<SaveApiKeyResult> {
    // Upstream divergence (sync-log: 877f4598): upstream delegates to the
    // owner-aware saveApiKeyForOwner; Dev keeps its pooled-tenancy member-key
    // path here because the owner-aware save is a managed-credential refusal.
    // Upstream divergence (sync-log: 1da19c20): endpoint/key re-entry applies only
    // to personal credential writes, which remain refused in Dev.
    // Upstream divergence (sync-log: 9c5ffa31): cloud key/settings edits
    // remain an organisation operation; personal keys cannot shadow Key Vault.
    // The organisation owns provider credentials. Older clients receive an
    // explicit refusal rather than creating a shadow per-user key.
    // Pooled tenants: a member may keep their own key for the models the
    // tenant's administrators list (tenant_settings.member_key_models).
    if (await getTenancyMode() !== "pooled") return { ok: false, kind: "env_configured" };
    const apiKey = params.apiKey?.trim();
    try {
        if (!apiKey) {
            await deleteUserApiKey(params.userId, params.provider, db);
        } else {
            if (!(await memberKeyAllowed(params.provider))) return { ok: false, kind: "member_key_not_enabled" };
            await setUserApiKey(params.userId, params.provider, apiKey, db);
        }
        return { ok: true, status: await getUserApiKeyStatus(params.userId, db) };
    } catch (error) {
        if (error instanceof ApiKeyEncryptionUnavailableError) return { ok: false, kind: "member_key_storage_unavailable" };
        return { ok: false, kind: "save_failed", error };
    }
}

/** Toggle a saved credential without changing its encrypted value or models. */
export function setApiKeyEnabled(
    db: Db,
    userId: string,
    provider: ApiKeyProvider,
    enabled: boolean,
): Promise<ServiceResult<ApiKeyStatus>> {
    return setApiKeyEnabledFor(db, userKeyOwner(userId), provider, enabled);
}
