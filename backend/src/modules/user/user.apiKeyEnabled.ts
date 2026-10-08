import type { Db } from "../../lib/supabase";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { getUserApiKeyStatus, type ApiKeyProvider, type ApiKeyStatus } from "./user.apiKeyStore";

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
