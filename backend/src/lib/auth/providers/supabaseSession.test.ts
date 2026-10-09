import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../runtimeConfig", () => ({
  supabaseSessionConfiguration: () => ({ url: "https://public-auth.example.test", key: "public-anon-key" }),
}));

import { createCredentialClient } from "./supabaseSession";
import type { ServerCredential } from "../../serverSession";

const user = { id: "text-user-id", email: "lawyer@example.test", app_metadata: { provider: "email" }, user_metadata: {}, aud: "authenticated", created_at: "2026-01-01T00:00:00Z" };
const token = [
  Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"),
  Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"),
  Buffer.from("signature").toString("base64url"),
].join(".");

describe("ordinary-user Supabase credential transport", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/auth/v1/user") && init?.method === "PUT") {
        return new Response(JSON.stringify(user), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/auth/v1/user")) {
        return new Response(JSON.stringify(user), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error("Unexpected auth request: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("binds the current user's token and updates through /user, never the admin API", async () => {
    const credential: ServerCredential = { provider: "supabase", userId: user.id, accessToken: token, refreshToken: "private-refresh" };
    const client = await createCredentialClient(credential);
    const result = await client.auth.updateUser({ password: "new-password", nonce: "123456" });
    expect(result.error).toBeNull();
    const calls = fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init: init as RequestInit }));
    expect(calls.some(call => call.url.endsWith("/auth/v1/user") && call.init.method === "PUT")).toBe(true);
    expect(calls.every(call => !call.url.includes("/admin/"))).toBe(true);
    const update = calls.find(call => call.init.method === "PUT")!;
    expect(new Headers(update.init.headers).get("Authorization")).toBe("Bearer " + token);
    expect(JSON.parse(String(update.init.body))).toEqual(expect.objectContaining({ password: "new-password", nonce: "123456" }));
  });

  it("rejects a provider session whose authenticated user differs from the cookie owner", async () => {
    await expect(createCredentialClient({ provider: "supabase", userId: "another-user", accessToken: token, refreshToken: "private-refresh" }))
      .rejects.toThrow("Supabase session is invalid");
  });
});
