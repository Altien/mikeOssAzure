import type { Db } from "../../lib/supabase";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { getUserApiKeyStatus, type ApiKeyOwner, type ApiKeyProvider, type ApiKeyStatus } from "./user.apiKeyStore";

/**
 * Upstream divergence (sync-log: 25779536): the caller changes only their
 * provider preference, atomically. Shared Key Vault credentials and legacy
 * encrypted key rows remain owned by the organisation and are never written.
 */
export async function setApiKeyEnabled(
    db: Db,
    userId: string,
    provider: ApiKeyProvider,
    enabled: boolean,
): Promise<ServiceResult<ApiKeyStatus>> {
    try {
        const { data, error } = await db.rpc("set_user_provider_enabled", {
            p_user_id: userId, p_provider: provider, p_enabled: enabled,
        });
        if (error) return internalFailure(error);
        if (data !== true) return failure("not_found", "User profile not found.");
        return ok(await getUserApiKeyStatus(userId, db));
    } catch (error) {
        return internalFailure(error);
    }
}

// Upstream divergence (sync-log: db8d42c3): only personal preference masks
// may be changed here; centrally managed provider configuration is immutable.
export async function setApiKeyEnabledFor(db: Db, owner: ApiKeyOwner, provider: ApiKeyProvider, enabled: boolean): Promise<ServiceResult<ApiKeyStatus>> {
    if (owner.kind === "user") return setApiKeyEnabled(db, owner.id, provider, enabled);
    return failure("forbidden", "Provider credentials are managed by the deployment administrator.");
}
