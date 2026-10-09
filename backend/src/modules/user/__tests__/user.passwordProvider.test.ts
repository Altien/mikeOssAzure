import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ provider: "supabase" }));
vi.mock("../../auth/auth.service", () => ({ authProvider: vi.fn(async () => state.provider) }));
vi.mock("../../../lib/runtimeConfig", () => ({
  supabaseSessionConfiguration: () => ({ url: "https://provider.example", key: "public-key" }),
}));
vi.mock("../user.profile.load", () => ({
  ensureProfileRow: vi.fn(async () => null),
  loadProfile: vi.fn(async () => ({ data: { user_id: "user-one" }, error: null })),
}));
vi.mock("../user.apiKeyStore", () => ({ getUserApiKeyStatus: vi.fn(async () => ({})) }));

import { recordPasswordSet } from "../user.profile.operations";

const fetchBefore = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchBefore; });
beforeEach(() => { state.provider = "supabase"; });

function fakeDb() {
  const update = vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) }));
  const from = vi.fn(() => ({ update }));
  return { db: { from } as never, from, update };
}

describe("ordinary provider password update", () => {
  it("never invokes a password provider or marks a profile for Entra admission", async () => {
    state.provider = "entra";
    globalThis.fetch = vi.fn();
    const { db, from } = fakeDb();
    const result = await recordPasswordSet(db, "user-one", "bearer", "new-password-123");
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("passes the current user's bearer and reauthentication nonce, and marks only a matching confirmed identity", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ id: "user-one" }), { status: 200 }));
    const { db, from, update } = fakeDb();
    const result = await recordPasswordSet(db, "user-one", "session-bearer", "new-password-123", "123456");
    expect(result.ok).toBe(true);
    const [url, options] = vi.mocked(globalThis.fetch).mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe("https://provider.example/auth/v1/user");
    expect(options.method).toBe("PUT");
    expect(options.headers).toMatchObject({ Authorization: "Bearer session-bearer", apikey: "public-key" });
    expect(JSON.parse(options.body as string)).toEqual({ password: "new-password-123", nonce: "123456" });
    expect(from).toHaveBeenCalledWith("user_profiles");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ password_set_at: expect.any(String) }));
  });

  it("does not mark a profile after provider rejection or mismatched identity", async () => {
    for (const response of [
      new Response(JSON.stringify({ message: "reauth required" }), { status: 422 }),
      new Response(JSON.stringify({ id: "other-user" }), { status: 200 }),
    ]) {
      globalThis.fetch = vi.fn(async () => response);
      const { db, from } = fakeDb();
      const result = await recordPasswordSet(db, "user-one", "session-bearer", "new-password-123");
      expect(result.ok).toBe(false);
      expect(from).not.toHaveBeenCalled();
    }
  });
});
