import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { makeFakeDb } from "../test/helpers/fakeDb";
import type { AuthPrincipal } from "../lib/auth/types";

const mocks = vi.hoisted(() => ({ db: null as unknown, membership: vi.fn(), named: vi.fn(), source: vi.fn(), mirror: vi.fn(), profile: vi.fn(), session: vi.fn(), state: vi.fn(), consumeState: vi.fn(), provider: "entra", externalClientId: "external-browser", principal: null as AuthPrincipal | null }));
vi.mock("../lib/config", () => ({ getConfig: async (name: string) => ({
  "tenancy-mode": "pooled", "auth-provider": mocks.provider, "pooled-onboarding-url": "https://onboarding.example.test/",
  "altien-entra-tenant-id": "external", "altien-entra-authority": "https://external.ciamlogin.com/external",
  "altien-entra-issuer": "https://external.ciamlogin.com/external/v2.0/", "altien-entra-jwks-uri": "https://external.ciamlogin.com/keys",
  "altien-entra-client-id": mocks.externalClientId, "altien-entra-backend-client-id": "external-api",
  "entra-client-id": "enterprise-browser", "entra-backend-client-id": "enterprise-api",
} as Record<string, string>)[name] || "" }));
vi.mock("../lib/supabase", () => ({ createServerSupabase: () => mocks.db, createPlatformSupabase: () => mocks.db }));
vi.mock("../lib/tenantMemberships", () => ({ findTenantMembership: mocks.membership, findDirectoryMembership: mocks.named, findIdentitySourceTenant: mocks.source, mirrorEnterpriseMembership: mocks.mirror }));
vi.mock("../lib/userLookup", () => ({ upsertUserProfile: mocks.profile }));
vi.mock("../lib/serverSession", () => ({
  readServerSession: vi.fn(async () => null), createServerSession: mocks.session,
  refreshServerSession: vi.fn(), clearServerSessionCookie: vi.fn(), consumeAuthHandoff: vi.fn(),
  consumeOAuthState: mocks.consumeState, createAuthHandoff: vi.fn(), createOAuthState: mocks.state,
  revokeServerSession: vi.fn(), replaceServerSession: vi.fn(),
}));
vi.mock("../lib/auth/providers/entra", () => ({ validateEntraToken: async () => ({ ok: true, principal: structuredClone(mocks.principal) }) }));
import { requireAuth } from "./auth";
import { authRouter } from "../modules/auth/auth.routes";
import { currentTenant } from "../lib/tenantContext";

const env = ["TENANCY_MODE", "AUTH_PROVIDER", "NODE_ENV", "JWT_SECRET", "FRONTEND_URL"] as const;
let saved: Record<string, string | undefined>;
let fixture: ReturnType<typeof makeFakeDb>;
let status: string;
let erased: boolean;
beforeEach(() => {
  saved = Object.fromEntries(env.map(key => [key, process.env[key]]));
  process.env.TENANCY_MODE = "pooled"; process.env.AUTH_PROVIDER = "entra"; process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "local-test-secret"; process.env.FRONTEND_URL = "https://app.example.test";
  mocks.provider = "entra"; mocks.externalClientId = "external-browser"; status = "active"; erased = false;
  mocks.named.mockReset().mockResolvedValue(undefined);
  mocks.principal = { userId: "same-user", email: "u@example.test", provider: "entra", identityKind: "altien", directoryId: "external", groups: [], roles: [] };
  mocks.membership.mockReset().mockResolvedValue({ tenantId: "tenant-a", role: "Member" });
  mocks.source.mockReset().mockResolvedValue("tenant-a");
  mocks.mirror.mockReset().mockResolvedValue(undefined);
  mocks.profile.mockReset().mockImplementation(async () => { expect(currentTenant()?.tenantId).toBe("tenant-a"); });
  mocks.session.mockReset().mockResolvedValue(undefined);
  mocks.state.mockReset().mockResolvedValue("state-token");
  mocks.consumeState.mockReset().mockResolvedValue({ provider: "microsoft", codeVerifier: "verifier", identityKind: "altien", returnUrl: "https://app.example.test/assistant" });
  fixture = makeFakeDb(call => {
    if (call.table === "tenants") return { data: { tenant_id: "tenant-a", status, enterprise_role_source: "groups" } };
    if (call.table === "tenant_group_policies") return { data: [{ group_object_id: "member-group", role: "Member" }] };
    if (call.table === "account_erasure_requests") return { data: erased ? { status: "requested" } : null };
    throw new Error("Unexpected table: " + call.table);
  });
  mocks.db = fixture.db;
});
afterEach(() => { vi.unstubAllGlobals(); for (const key of env) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
function app() {
  const app = express(); app.use(express.json()); app.use(cookieParser()); app.use("/api/auth", authRouter);
  app.get("/private", requireAuth, (_req, res) => res.json({ tenant: currentTenant()?.tenantId, roles: res.locals.principal.roles }));
  return app;
}
describe("pooled admission before tenant data access", () => {
  it("returns onboarding for an External ID user without a membership and touches no tenant data", async () => {
    mocks.membership.mockResolvedValue(undefined);
    const res = await request(app()).get("/private").set("Authorization", "Bearer test");
    expect(res.status).toBe(403); expect(res.body).toMatchObject({ code: "onboarding_required", onboardingUrl: "https://onboarding.example.test/" });
    expect(fixture.calls).toEqual([]); expect(mocks.profile).not.toHaveBeenCalled();
  });
  it("rejects a suspended tenant before erasure reads or profile writes", async () => {
    status = "suspended";
    const res = await request(app()).get("/private").set("Authorization", "Bearer test");
    expect(res.status).toBe(403);
    expect(fixture.calls.map(call => call.table)).toEqual(["tenants"]); expect(mocks.profile).not.toHaveBeenCalled();
  });
  it("seeds an admitted member only inside the resolved tenant", async () => {
    const res = await request(app()).get("/private").set("Authorization", "Bearer test");
    expect(res.status).toBe(200); expect(res.body).toEqual({ tenant: "tenant-a", roles: ["Member"] });
    // Main's personal organization is ensured in the same admitted scope.
    expect(fixture.calls.map(call => call.table)).toEqual(["tenants", "account_erasure_requests", "ensure_personal_organization"]);
    expect(mocks.profile).toHaveBeenCalledOnce();
  });
  it("requires a tenant-owned group match for enterprise JIT", async () => {
    mocks.principal = { ...mocks.principal!, identityKind: "enterprise", directoryId: "enterprise", groups: ["unlisted"] };
    const denied = await request(app()).get("/private").set("Authorization", "Bearer test");
    expect(denied.status).toBe(403); expect(mocks.profile).not.toHaveBeenCalled();
    mocks.principal.groups = ["member-group"];
    const allowed = await request(app()).get("/private").set("Authorization", "Bearer test");
    expect(allowed.status).toBe(200);
    expect(mocks.membership).not.toHaveBeenCalled();
    expect(fixture.calls.filter(call => call.table === "tenant_group_policies").every(call => call.filters.some(f => f[1] === "tenant_id" && f[2] === "tenant-a"))).toBe(true);
  });
  it("honors account tombstones after admission without recreating a profile", async () => {
    erased = true;
    const res = await request(app()).get("/private").set("Authorization", "Bearer test");
    expect(res.status).toBe(410); expect(mocks.profile).not.toHaveBeenCalled();
  });
  it("creates a local login session only after membership and active-tenant admission", async () => {
    mocks.provider = "local"; process.env.AUTH_PROVIDER = "local";
    const res = await request(app()).post("/api/auth/local-login").set("Origin", "https://app.example.test").send({ email: "member@example.test", tenantId: "attacker-tenant" });
    expect(res.status, res.text).toBe(200);
    expect(mocks.session.mock.calls[0][2]).toMatchObject({ provider: "local", tenantId: "tenant-a" });
    expect(mocks.membership).toHaveBeenCalledWith(res.body.user.id);
  });
  it("does not create a session for local users without membership", async () => {
    mocks.provider = "local"; process.env.AUTH_PROVIDER = "local"; mocks.membership.mockResolvedValue(undefined);
    const res = await request(app()).post("/api/auth/local-login").set("Origin", "https://app.example.test").send({ email: "member@example.test" });
    expect(res.status).toBe(403); expect(mocks.session).not.toHaveBeenCalled(); expect(fixture.calls).toEqual([]);
  });
});

it("binds each OAuth login choice to its authority, client and encrypted state", async () => {
  const standard = await request(app()).get("/api/auth/login-provider/microsoft");
  expect(standard.status).toBe(302); const standardUrl = new URL(standard.headers.location);
  expect(standardUrl.hostname).toBe("external.ciamlogin.com"); expect(standardUrl.searchParams.get("client_id")).toBe("external-browser");
  expect(mocks.state.mock.calls[0][0]).toMatchObject({ identityKind: "altien" });
  const enterprise = await request(app()).get("/api/auth/login-provider/microsoft?identity=enterprise");
  expect(enterprise.status).toBe(302); const enterpriseUrl = new URL(enterprise.headers.location);
  expect(enterpriseUrl.pathname).toBe("/common/oauth2/v2.0/authorize"); expect(enterpriseUrl.searchParams.get("client_id")).toBe("enterprise-browser");
  expect(mocks.state.mock.calls[1][0]).toMatchObject({ identityKind: "enterprise" });
});
it("makes Microsoft the default and only login when External ID is not configured", async () => {
  mocks.externalClientId = "";
  const res = await request(app()).get("/api/auth/login-provider/microsoft");
  expect(res.status).toBe(302); const url = new URL(res.headers.location);
  expect(url.hostname).toBe("login.microsoftonline.com"); expect(url.pathname).toBe("/common/oauth2/v2.0/authorize");
  expect(url.searchParams.get("client_id")).toBe("enterprise-browser");
  expect(mocks.state.mock.calls[0][0]).toMatchObject({ identityKind: "enterprise" });
});
it("admits a named Microsoft member with its membership role, without app roles or mirroring", async () => {
  mocks.principal = { ...mocks.principal!, identityKind: "enterprise", directoryId: "personal", appRoles: ["Mike.Admin"] };
  mocks.named.mockResolvedValue({ tenantId: "tenant-a", role: "Member" });
  const res = await request(app()).get("/private").set("Authorization", "Bearer test");
  expect(res.status).toBe(200); expect(res.body).toEqual({ tenant: "tenant-a", roles: ["Member"] });
  expect(mocks.named).toHaveBeenCalledWith("personal", "same-user");
  expect(mocks.source).not.toHaveBeenCalled(); expect(mocks.mirror).not.toHaveBeenCalled();
});
it("sends a Microsoft user with no tenant to onboarding (API 403 and browser callback redirect)", async () => {
  mocks.principal = { ...mocks.principal!, identityKind: "enterprise", directoryId: "unlinked" };
  mocks.source.mockResolvedValue(undefined);
  const api = await request(app()).get("/private").set("Authorization", "Bearer test");
  expect(api.status).toBe(403); expect(api.body).toMatchObject({ code: "onboarding_required", onboardingUrl: "https://onboarding.example.test/" });
  mocks.consumeState.mockResolvedValue({ provider: "microsoft", codeVerifier: "verifier", identityKind: "enterprise", returnUrl: "https://app.example.test/assistant" });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ access_token: "validated-token", expires_in: 3600 }) })));
  const callback = await request(app()).get("/api/auth/openid-callback/microsoft?code=code&state=state").set("Cookie", "mike-oauth-browser=nonce");
  expect(callback.status).toBe(302); expect(callback.headers.location).toBe("https://onboarding.example.test/");
  expect(mocks.session).not.toHaveBeenCalled(); expect(mocks.profile).not.toHaveBeenCalled(); expect(fixture.calls).toEqual([]);
});
it("redirects a valid External ID callback without membership to onboarding without a session", async () => {
  mocks.membership.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ access_token: "validated-token", expires_in: 3600 }) })));
  const res = await request(app()).get("/api/auth/openid-callback/microsoft?code=code&state=state").set("Cookie", "mike-oauth-browser=nonce");
  expect(res.status).toBe(302); expect(res.headers.location).toBe("https://onboarding.example.test/");
  expect(mocks.session).not.toHaveBeenCalled(); expect(mocks.profile).not.toHaveBeenCalled(); expect(fixture.calls).toEqual([]);
});
it("carries trusted app roles and GET-only read intent after enterprise admission", async () => {
  mocks.principal = { ...mocks.principal!, identityKind: "enterprise", directoryId: "enterprise", appRoles: ["Mike.Admin"] };
  const testApp = express();
  testApp.get("/scope", requireAuth, (_req, res) => res.json(currentTenant()));
  testApp.post("/scope", requireAuth, (_req, res) => res.json(currentTenant()));
  const response = await request(testApp).get("/scope").set("Authorization", "Bearer test");
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ tenantId: "tenant-a", userId: "same-user", roles: ["TenantAdmin", "Member"], pooled: true, readOnly: true });
  expect(mocks.mirror).toHaveBeenCalledWith("tenant-a", "same-user", "enterprise", "TenantAdmin");
  const write = await request(testApp).post("/scope").set("Authorization", "Bearer test");
  expect(write.status).toBe(200); expect(write.body.readOnly).not.toBe(true);
});
it("refuses admission before profile writes if enterprise mirroring conflicts", async () => {
  mocks.principal = { ...mocks.principal!, identityKind: "enterprise", directoryId: "enterprise", appRoles: ["Mike.Admin"] };
  mocks.mirror.mockRejectedValue(new Error("Identity source conflict"));
  const response = await request(app()).get("/private").set("Authorization", "Bearer test");
  expect(response.status).toBe(503); expect(mocks.profile).not.toHaveBeenCalled();
});
