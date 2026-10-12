// User BYO API keys: status read + save.
//
// Service layer behind user.routes.ts — see user.shared.ts for the module's
// contract. Security boundary preserved verbatim: writes funnel through
// saveUserApiKey (the crypto is never reimplemented here).

import {
    type ApiKeyOwner,
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
    _params: { userId: string; provider: ApiKeyProvider; apiKey: string | null; settings?: unknown },
): Promise<SaveApiKeyResult> {
    // Upstream divergence (sync-log: 1da19c20): endpoint/key re-entry applies only
    // to personal credential writes, which remain refused in Dev.
    // Upstream divergence (sync-log: 9c5ffa31): cloud key/settings edits
    // remain an organisation operation; personal keys cannot shadow Key Vault.
    // The organisation owns provider credentials. Older clients receive an
    // explicit refusal rather than creating a shadow per-user key.
    return { ok: false, kind: "env_configured" };
}

// Upstream divergence (sync-log: db8d42c3): managed credentials are edited
// through deployment Key Vault administration, never organization DB rows.
export async function saveApiKeyForOwner(
    _db: Db,
    _params: { owner: ApiKeyOwner; provider: ApiKeyProvider; apiKey: string | null; settings?: unknown; savedBy?: string },
): Promise<SaveApiKeyResult> {
    return { ok: false, kind: "env_configured" };
}
