// Dev drift: report real opaque-session/tombstone/profile boundaries; MFA belongs to Entra.
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../lib/appError";
const mocks = vi.hoisted(() => ({ reportError: vi.fn(), session: vi.fn(), database: vi.fn(), upsert: vi.fn(), provider: undefined as string | undefined, refresh: vi.fn(), revoke: vi.fn(), clearCookie: vi.fn() }));
vi.mock("../lib/observability/sentry", async load => ({ ...await load<Record<string, unknown>>(), reportError: mocks.reportError }));
vi.mock("../lib/config", () => ({ getConfig: vi.fn(async () => mocks.provider ?? "local") }));
vi.mock("../lib/serverSession", () => ({ readServerSession: mocks.session, refreshServerSession: mocks.refresh, revokeServerSession: mocks.revoke, clearServerSessionCookie: mocks.clearCookie }));
vi.mock("../lib/auth/providers/local.js", () => ({ validateLocalToken: vi.fn(async () => ({ ok: true, principal: { userId: "u1", email: "u@example.test", emailVerified: true, provider: "local" } })) }));
vi.mock("../lib/supabase", () => ({ createServerSupabase: mocks.database }));
vi.mock("../lib/userLookup", () => ({ upsertUserProfile: mocks.upsert }));
vi.mock("./tenantAccess.js", () => ({ tenantAccess: (_req: unknown, _res: unknown, next: () => void) => next() }));
import { requireAuth } from "./auth";
const ROUTE = "/api/user/profile";
function app() { const a = express(); a.get(ROUTE, requireAuth, (_req, res) => res.json({ ok: true })); return a; }
function failure(kind: string, cause: unknown) { expect(mocks.reportError).toHaveBeenCalledOnce(); expect(mocks.reportError.mock.calls[0]?.[0]).toBeInstanceOf(AppError); expect(mocks.reportError.mock.calls[0]?.[0]).toMatchObject({ kind, cause }); expect(mocks.reportError.mock.calls[0]?.[1]).toMatchObject({ tags: { component: "http", http_method: "GET", http_route: ROUTE } }); }
describe("auth middleware failure reporting", () => {
 beforeEach(() => { vi.clearAllMocks(); mocks.provider = undefined; mocks.upsert.mockResolvedValue(undefined); const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: null }) }; mocks.database.mockReturnValue({ from: () => q }); });
 afterEach(() => vi.restoreAllMocks());
 it("reports an unavailable opaque cookie session once without exposing its cause", async () => { const cause = new Error("private session store address"); mocks.session.mockRejectedValue(cause); const res = await request(app()).get(ROUTE); expect(res.status).toBe(503); expect(res.body).toEqual({ detail: "Auth session is unavailable" }); expect(res.text).not.toContain(cause.message); failure("auth.session_lookup_failed", cause); expect(mocks.upsert).not.toHaveBeenCalled(); });
 it("fails closed and reports an unavailable account tombstone store", async () => { const cause = new Error("private database address"); mocks.database.mockImplementation(() => { throw cause; }); const res = await request(app()).get(ROUTE).set("Authorization", "Bearer valid-local-token"); expect(res.status).toBe(503); expect(res.body).toEqual({ detail: "Account status is unavailable" }); failure("db.query_failed", cause); expect(mocks.upsert).not.toHaveBeenCalled(); });
 it("reports a profile initialization failure once and keeps its response opaque", async () => { const cause = new Error("private profile row"); mocks.upsert.mockRejectedValue(cause); const res = await request(app()).get(ROUTE).set("Authorization", "Bearer valid-local-token"); expect(res.status).toBe(500); expect(res.body).toEqual({ detail: "Unable to initialize user profile" }); expect(res.text).not.toContain(cause.message); failure("db.query_failed", cause); });
 // Upstream b9f0ead8, adapted: a refresh token GoTrue refused is a sign-in-again 401, not a reported 503.
 function expiredSupabaseSession() { mocks.provider = "supabase"; mocks.session.mockResolvedValue({ row: { version: 1, token_expires_at: new Date(Date.now() - 1000).toISOString() }, credential: { provider: "supabase", userId: "u1", accessToken: "a", refreshToken: "r" } }); }
 function authJsError(name: string, status: number) { return Object.assign(new Error("gotrue"), { __isAuthError: true, name, status }); }
 it("answers a refresh token GoTrue refused with 401 session_expired and revokes the session", async () => { expiredSupabaseSession(); mocks.refresh.mockRejectedValue(new Error("Supabase refresh failed", { cause: authJsError("AuthApiError", 400) })); const res = await request(app()).get(ROUTE); expect(res.status).toBe(401); expect(res.body).toEqual({ code: "session_expired", detail: "Invalid or expired session" }); expect(mocks.revoke).toHaveBeenCalledOnce(); expect(mocks.clearCookie).toHaveBeenCalledOnce(); expect(mocks.reportError).not.toHaveBeenCalled(); });
 it("keeps the session and reports a 503 when GoTrue cannot be reached during a refresh", async () => { expiredSupabaseSession(); const cause = new Error("Supabase refresh failed", { cause: authJsError("AuthRetryableFetchError", 503) }); mocks.refresh.mockRejectedValue(cause); const res = await request(app()).get(ROUTE); expect(res.status).toBe(503); expect(mocks.revoke).not.toHaveBeenCalled(); expect(mocks.clearCookie).not.toHaveBeenCalled(); failure("auth.session_lookup_failed", cause); });
});
