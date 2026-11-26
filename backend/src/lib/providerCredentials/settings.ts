// Owner-aware credential settings. Callers must authorize the owner.
import type { Db } from "../supabase";
import type { ApiKeyOwner, ApiKeyProvider, ApiKeyStatus } from "./types";

// Upstream divergence (sync-log: 877f4598): upstream moved its owner-aware
// key/settings save (Vertex key shape, endpoint re-entry, org savedBy) here
// from user.apiKeys. Dev's provider credentials are managed in Key Vault, so
// the owner-aware save stays a refusal (sync-log: db8d42c3) and the result
// keeps Dev's pooled-tenancy kinds used by the personal save.
export type SaveApiKeyResult =
    | { ok: true; status: ApiKeyStatus }
    | { ok: false; kind: "env_configured" }
    | { ok: false; kind: "member_key_not_enabled" }
    | { ok: false; kind: "member_key_storage_unavailable" }
    | { ok: false; kind: "save_failed"; error: unknown };

// Upstream divergence (sync-log: db8d42c3): managed credentials are edited
// through deployment Key Vault administration, never organization DB rows.
export async function saveApiKeyForOwner(
    _db: Db,
    _params: { owner: ApiKeyOwner; provider: ApiKeyProvider; apiKey: string | null; settings?: unknown; savedBy?: string },
): Promise<SaveApiKeyResult> {
    return { ok: false, kind: "env_configured" };
}
