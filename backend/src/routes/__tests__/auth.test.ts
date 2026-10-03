import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const user = { id: "text-user-1", email: "lawyer@example.test", app_metadata: { provider: "google" } };
  const session = { access_token: "private-access", refresh_token: "private-refresh", expires_in: 3600, user };
  const auth = {
    signInWithPassword: vi.fn(), signUp: vi.fn(), getUser: vi.fn(), signOut: vi.fn(),
    updateUser: vi.fn(), reauthenticate: vi.fn(),
    mfa: { listFactors: vi.fn(), getAuthenticatorAssuranceLevel: vi.fn(), enroll: vi.fn(), challenge: vi.fn(), verify: vi.fn(), challengeAndVerify: vi.fn(), unenroll: vi.fn() },
  };
  return { user, session, auth, createServerSession: vi.fn(), replaceServerSession: vi.fn(),
    consumeAuthHandoff: vi.fn(), createOAuthState: vi.fn(), startSupabaseOAuth: vi.fn(),
    readServerSession: vi.fn(), createCredentialClient: vi.fn(), getConfig: vi.fn(),
  };
});

vi.mock("../../lib/config", () => ({ getConfig: mocks.getConfig }));
vi.mock("../../lib/auth/providers/supabaseSession", () => ({
  createSupabaseAuthClient: () => ({ auth: mocks.auth }),
  createCredentialClient: mocks.createCredentialClient,
  startSupabaseOAuth: mocks.startSupabaseOAuth,
  startSupabaseRecovery: vi.fn(),
  exchangeSupabaseOAuth: vi.fn(),
  supabaseCredential: (session: typeof mocks.session) => ({ provider: "supabase", userId: session.user.id, accessToken: session.access_token, refreshToken: session.refresh_token }),
  supabaseExpiresAt: () => new Date(Date.now() + 3600_000),
  publicSupabaseUser: (user: typeof mocks.user) => ({ id: user.id, email: user.email, pendingEmail: null, createdWithGoogle: user.app_metadata.provider === "google" }),
}));
vi.mock("../../lib/serverSession", () => ({
  clearServerSessionCookie: vi.fn(), consumeAuthHandoff: mocks.consumeAuthHandoff,
  consumeOAuthState: vi.fn(), createAuthHandoff: vi.fn(), createOAuthState: mocks.createOAuthState,
  createServerSession: mocks.createServerSession, replaceServerSession: mocks.replaceServerSession,
  readServerSession: mocks.readServerSession, revokeServerSession: vi.fn(),
}));
vi.mock("../../lib/auth/providers/supabase", () => ({
  validateSupabaseToken: vi.fn(async () => ({ ok: true, principal: { userId: mocks.user.id, email: mocks.user.email, provider: "supabase" } })),
}));
vi.mock("../../lib/auth/providers/entra", () => ({ validateEntraToken: vi.fn() }));
vi.mock("../../lib/auth/providers/local", () => ({ validateLocalToken: vi.fn() }));
vi.mock("../../middleware/auth", () => ({ requireAuth: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
  res.locals.userId = mocks.user.id; res.locals.token = "private-access";
  res.locals.authSource = "cookie"; res.locals.principal = { userId: mocks.user.id, email: mocks.user.email, provider: "supabase" };
  next();
} }));
vi.mock("../../middleware/tenantAccess", () => ({ tenantAccess: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../../lib/userSettings", () => ({ upsertUserProfile: vi.fn(async () => undefined) }));

import { authRouter } from "../auth";
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/auth", authRouter);

describe("server-owned auth routes", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
    process.env.FRONTEND_URL = "https://web.example.test";
    process.env.WORD_ADDIN_URL = "https://word.example.test";
    mocks.getConfig.mockReset().mockImplementation(async (name: string) => name === "auth-provider" ? "supabase" : "https://web.example.test");
    for (const value of Object.values(mocks.auth)) if (typeof value === "function") value.mockReset();
    for (const value of Object.values(mocks.auth.mfa)) value.mockReset();
    for (const name of ["createServerSession", "replaceServerSession", "consumeAuthHandoff", "createOAuthState", "startSupabaseOAuth", "readServerSession", "createCredentialClient"] as const) mocks[name].mockReset();
    mocks.createCredentialClient.mockResolvedValue({ auth: mocks.auth });
    mocks.readServerSession.mockResolvedValue({ credential: { provider: "supabase", userId: mocks.user.id, accessToken: "private-access", refreshToken: "private-refresh" } });
  });

  it("rejects a login from an untrusted Origin before contacting the provider", async () => {
    const response = await request(app).post("/auth/login").set("Origin", "https://attacker.example")
      .send({ email: mocks.user.email, password: "long-password" });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("untrusted_origin");
    expect(mocks.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("stores a provider session server-side and returns no reusable token", async () => {
    mocks.auth.signInWithPassword.mockResolvedValue({ data: { user: mocks.user, session: mocks.session }, error: null });
    const response = await request(app).post("/auth/login").set("Origin", "https://web.example.test")
      .send({ email: mocks.user.email, password: "long-password" });
    expect(response.status).toBe(200);
    expect(mocks.createServerSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ userId: mocks.user.id, accessToken: "private-access" }), expect.any(Date));
    expect(response.body.user).toEqual({ id: mocks.user.id, email: mocks.user.email, pendingEmail: null, createdWithGoogle: true });
    expect(JSON.stringify(response.body)).not.toContain("private-access");
    expect(JSON.stringify(response.body)).not.toContain("private-refresh");
  });

  it("redeems only a trusted Word-origin one-use handoff", async () => {
    mocks.consumeAuthHandoff.mockResolvedValue({ provider: "supabase", userId: mocks.user.id, accessToken: "private-access", refreshToken: "private-refresh" });
    const body = { ticket: "a".repeat(43), requestId: "word-request-123456" };
    const denied = await request(app).post("/auth/handoff").set("Origin", "https://attacker.example").send(body);
    expect(denied.status).toBe(403);
    const response = await request(app).post("/auth/handoff").set("Origin", "https://word.example.test").send(body);
    expect(response.status).toBe(200);
    expect(mocks.consumeAuthHandoff).toHaveBeenCalledWith(body.ticket, "https://word.example.test", body.requestId);
    expect(JSON.stringify(response.body)).not.toContain("private-access");
  });

  it("does not report a rejected ordinary-user password change as success", async () => {
    mocks.auth.updateUser.mockResolvedValue({ data: { user: null }, error: new Error("reauthentication required") });
    const response = await request(app).patch("/auth/password").set("Origin", "https://web.example.test")
      .send({ password: "new-secure-password", nonce: "123456" });
    expect(response.status).toBe(400);
    expect(mocks.auth.updateUser).toHaveBeenCalledWith({ password: "new-secure-password", nonce: "123456" });
    expect(mocks.createServerSession).not.toHaveBeenCalled();
  });

  it("rotates the server credential after successful MFA without exposing elevated tokens", async () => {
    mocks.auth.mfa.verify.mockResolvedValue({ data: { access_token: "elevated-access", refresh_token: "elevated-refresh", expires_in: 3600, user: mocks.user }, error: null });
    const response = await request(app).post("/auth/mfa/verify").set("Origin", "https://web.example.test")
      .send({ factorId: "factor-1", challengeId: "challenge-1", code: "123456" });
    expect(response.status).toBe(200);
    expect(mocks.replaceServerSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ accessToken: "elevated-access" }), expect.any(Date));
    expect(JSON.stringify(response.body)).not.toContain("elevated-access");
  });
});
