import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

// Multi-tenant: the session-table probe runs as the platform (no tenant yet).
const probeDb = () => ({
  from: () => ({ select: () => ({ limit: async () => ({ error: null }) }) }),
});
vi.mock("../supabase", () => ({
  createServerSupabase: probeDb,
  createPlatformSupabase: probeDb,
}));

const canonical = () => randomBytes(32).toString("base64url");

async function init(state: string) {
  vi.stubEnv("KEY_VAULT_NAME", "");
  vi.stubEnv("AUTH_SESSION_ENCRYPTION_SECRET", canonical());
  vi.stubEnv("AUTH_HANDOFF_ENCRYPTION_SECRET", canonical());
  vi.stubEnv("AUTH_STATE_SECRET", state);
  vi.resetModules();
  const { initServerSessionKeys } = await import("../serverSession");
  return initServerSessionKeys();
}

describe("auth-state-secret compatibility", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts canonical, legacy GUID and hand-provisioned base64 state secrets", async () => {
    await expect(init(canonical())).resolves.toBeUndefined();
    await expect(init("0f8fad5b-d9cb-469f-a165-70867728950e")).resolves.toBeUndefined();
    await expect(init(randomBytes(36).toString("base64"))).resolves.toBeUndefined();
  });

  it("still rejects short or placeholder state secrets", async () => {
    await expect(init("too-short")).rejects.toThrow("auth-state-secret must be 32 random bytes");
    await expect(init("replace-me-with-a-real-secret-value-please")).rejects.toThrow("not configured");
  });
});
