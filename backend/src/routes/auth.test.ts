import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(), createOAuthState: vi.fn(), consumeOAuthState: vi.fn(),
  createServerSession: vi.fn(), createAuthHandoff: vi.fn(),
  validateEntraToken: vi.fn(), validateLocalToken: vi.fn(),
  upsertUserProfile: vi.fn(),
}));

vi.mock("../lib/config", () => ({ getConfig: mocks.getConfig }));
vi.mock("../lib/serverSession", () => ({
  createOAuthState: mocks.createOAuthState, consumeOAuthState: mocks.consumeOAuthState,
  createServerSession: mocks.createServerSession, createAuthHandoff: mocks.createAuthHandoff,
  clearServerSessionCookie: vi.fn(), consumeAuthHandoff: vi.fn(),
  readServerSession: vi.fn(), revokeServerSession: vi.fn(), replaceServerSession: vi.fn(),
}));
vi.mock("../lib/auth/providers/entra", () => ({ validateEntraToken: mocks.validateEntraToken }));
vi.mock("../lib/auth/providers/local", () => ({ validateLocalToken: mocks.validateLocalToken }));
vi.mock("../lib/auth/providers/supabase", () => ({ validateSupabaseToken: vi.fn() }));
vi.mock("../lib/auth/providers/supabaseSession", () => ({
  createSupabaseAuthClient: vi.fn(), createCredentialClient: vi.fn(),
  exchangeSupabaseOAuth: vi.fn(), startSupabaseOAuth: vi.fn(),
  startSupabaseRecovery: vi.fn(), supabaseCredential: vi.fn(),
  supabaseExpiresAt: vi.fn(), publicSupabaseUser: vi.fn(),
}));
vi.mock("../lib/userSettings", () => ({ upsertUserProfile: mocks.upsertUserProfile }));
vi.mock("../middleware/tenantAccess", () => ({ tenantAccess: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../middleware/auth", () => ({ requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() }));

import { authRouter } from "./auth";

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/auth", authRouter);

const principal = { userId: "text-id", email: "lawyer@example.test", displayName: "Lawyer", provider: "entra", groups: [] };
const requestId = "word-request-123456";
const wordOrigin = "https://word.example.test";

describe("Entra and local server-session routes", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.FRONTEND_URL = "https://web.example.test";
    process.env.WORD_ADDIN_URL = wordOrigin;
    process.env.JWT_SECRET = "local-secret-32-bytes-for-tests-only";
    delete process.env.ENTRA_REDIRECT_URI;
    mocks.getConfig.mockReset().mockImplementation(async (name: string) => ({
      "auth-provider": "entra", "entra-tenant-id": "tenant-id", "entra-client-id": "client-id",
      "entra-client-secret": "client-secret", "entra-backend-client-id": "backend-id",
      "backend-public-url": "https://api.example.test",
    })[name] ?? "");
    for (const name of ["createOAuthState", "consumeOAuthState", "createServerSession", "createAuthHandoff", "validateEntraToken", "validateLocalToken", "upsertUserProfile"] as const) mocks[name].mockReset();
    mocks.createOAuthState.mockResolvedValue("s".repeat(43));
    mocks.validateEntraToken.mockResolvedValue({ ok: true, principal });
    mocks.validateLocalToken.mockImplementation(async (token: string) => ({
      ok: true, principal: { ...principal, provider: "local", userId: JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub },
    }));
    mocks.createAuthHandoff.mockResolvedValue("t".repeat(43));
  });

  it("advertises Microsoft only when Entra is configured", async () => {
    const response = await request(app).get("/api/auth/providers");
    expect(response.status).toBe(200);
    expect(response.body.defaultProvider).toBe("microsoft");
    expect(response.body.providers).toContainEqual({ id: "microsoft", name: "Microsoft", mode: "openid", enabled: true });
  });

  it("mints an opaque local cookie without returning the local JWT", async () => {
    mocks.getConfig.mockImplementation(async (name: string) => name === "auth-provider" ? "local" : "");
    const denied = await request(app).post("/api/auth/local-login").set("Origin", "https://attacker.example")
      .send({ email: "lawyer@example.test" });
    expect(denied.status).toBe(403);
    const response = await request(app).post("/api/auth/local-login").set("Origin", "https://web.example.test")
      .send({ email: " Lawyer@Example.Test " });
    expect(response.status).toBe(200);
    expect(mocks.createServerSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ provider: "local", accessToken: expect.stringMatching(/^[^.]+\.[^.]+\.[^.]+$/) }), expect.any(Date));
    expect(response.body.user.email).toBe("lawyer@example.test");
    expect(JSON.stringify(response.body)).not.toContain("token");
  });

  it("stores a browser-bound PKCE challenge and uses the exact configured redirect", async () => {
    const response = await request(app).get("/api/auth/login-provider/microsoft?returnUrl=https%3A%2F%2Fevil.example%2F");
    expect(response.status).toBe(302);
    const location = new URL(response.headers.location);
    expect(location.host).toBe("login.microsoftonline.com");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("redirect_uri")).toBe("https://api.example.test/api/auth/openid-callback/microsoft");
    expect(mocks.createOAuthState).toHaveBeenCalledWith(expect.objectContaining({ provider: "microsoft", returnUrl: "https://web.example.test/assistant", targetOrigin: "https://web.example.test", codeVerifier: expect.any(String), browserNonce: expect.any(String) }));
    expect(response.headers["set-cookie"].join(" ")).toContain("mike-oauth-browser=");
    expect(response.headers.location).not.toContain("client-secret");
  });

  it("rejects a callback without the initiating browser nonce before exchanging a code", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await request(app).get("/api/auth/openid-callback/microsoft?code=private-code&state=state");
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.consumeOAuthState).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("hands a Word callback a one-use ticket with no bearer token or credential cookie", async () => {
    mocks.consumeOAuthState.mockResolvedValue({ provider: "microsoft", codeVerifier: "verifier", targetOrigin: wordOrigin, requestId, returnUrl: "https://web.example.test/assistant" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => ({ access_token: "private-access-token", refresh_token: "private-refresh-token", expires_in: 3600 }) } as Response);
    const response = await request(app).get("/api/auth/openid-callback/microsoft?code=private-code&state=state")
      .set("Cookie", "mike-oauth-browser=" + "n".repeat(43));
    expect(response.status).toBe(200);
    expect(mocks.consumeOAuthState).toHaveBeenCalledWith("state", "n".repeat(43));
    expect(mocks.createAuthHandoff).toHaveBeenCalledWith(expect.objectContaining({ provider: "entra", accessToken: "private-access-token" }), wordOrigin, requestId);
    expect(response.text).toContain('"handoffTicket":"' + "t".repeat(43) + '"');
    expect(response.text).not.toContain("private-access-token");
    expect(response.text).not.toContain("private-refresh-token");
    expect(mocks.createServerSession).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls[0][1]?.body?.toString()).toContain("code_verifier=verifier");
    fetchSpy.mockRestore();
  });
});
