// User BYO API keys: status read + save.
//
// Service layer behind user.routes.ts — see user.shared.ts for the module's
// contract. Security boundary preserved verbatim: writes funnel through
// saveUserApiKey (the crypto is never reimplemented here).

import {
    type ApiKeyProvider,
    type ApiKeyStatus,
    getUserApiKeyStatus,
} from "./user.apiKeyStore";
import { type Db } from "./user.shared";

export function getApiKeyStatus(db: Db, userId: string) {
    return getUserApiKeyStatus(userId, db);
}

export type SaveApiKeyResult =
    | { ok: true; status: ApiKeyStatus }
    | { ok: false; kind: "env_configured" }
    | { ok: false; kind: "save_failed"; error: unknown };

export async function saveApiKey(
    _db: Db,
    _params: { userId: string; provider: ApiKeyProvider; apiKey: string | null },
): Promise<SaveApiKeyResult> {
    // The organisation owns provider credentials. Older clients receive an
    // explicit refusal rather than creating a shadow per-user key.
    return { ok: false, kind: "env_configured" };
}
