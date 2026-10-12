import { describe, expect, it, vi } from "vitest";
import { saveApiKeyForOwner } from "../user.apiKeys";
import { orgKeyOwner, userKeyOwner } from "../user.apiKeyStore";
import type { Db } from "../../../lib/supabase";

// Upstream divergence (sync-log: db8d42c3): owner-aware interfaces are
// retained, but managed deployments never persist personal/org secret rows.
describe("managed owner credential policy", () => {
    it.each([userKeyOwner("user"), orgKeyOwner("org")])("refuses writes for %j", async (owner) => {
        const from = vi.fn(() => { throw new Error("must not write secrets"); });
        const result = await saveApiKeyForOwner({ from } as unknown as Db, { owner, provider: "claude", apiKey: "test" });
        expect(result).toEqual({ ok: false, kind: "env_configured" });
        expect(from).not.toHaveBeenCalled();
    });
});
