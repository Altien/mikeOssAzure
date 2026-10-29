// Dev drift: report real opaque-session/tombstone/profile boundaries; MFA belongs to Entra.
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../lib/appError";
const mocks = vi.hoisted(() => ({ reportError: vi.fn(), session: vi.fn(), database: vi.fn(), upsert: vi.fn() }));
vi.mock("../lib/observability/sentry", async load => ({ ...await load<Record<string, unknown>>(), reportError: mocks.reportError }));
vi.mock("../lib/config", () => ({ getConfig: vi.fn(async () => "local") }));
vi.mock("../lib/serverSession", () => ({ readServerSession: mocks.session, refreshServerSession: vi.fn() }));
vi.mock("../lib/auth/providers/local.js", () => ({ validateLocalToken: vi.fn(async () => ({ ok: true, principal: { userId: "u1", email: "u@example.test", emailVerified: true, provider: "local" } })) }));
vi.mock("../lib/supabase", () => ({ createServerSupabase: mocks.database }));
vi.mock("../lib/userLookup", () => ({ upsertUserProfile: mocks.upsert }));
vi.mock("./tenantAccess.js", () => ({ tenantAccess: (_req: unknown, _res: unknown, next: () => void) => next() }));
import { requireAuth } from "./auth";
const ROUTE = "/api/user/profile";
function app() { const a = express(); a.get(ROUTE, requireAuth, (_req, res) => res.json({ ok: true })); return a; }
function failure(kind: string, cause: unknown) { expect(mocks.reportError).toHaveBeenCalledOnce(); expect(mocks.reportError.mock.calls[0]?.[0]).toBeInstanceOf(AppError); expect(mocks.reportError.mock.calls[0]?.[0]).toMatchObject({ kind, cause }); expect(mocks.reportError.mock.calls[0]?.[1]).toMatchObject({ tags: { component: "http", http_method: "GET", http_route: ROUTE } }); }
describe("auth middleware failure reporting", () => {
 beforeEach(() => { vi.clearAllMocks(); mocks.upsert.mockResolvedValue(undefined); const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: null, error: null }) }; mocks.database.mockReturnValue({ from: () => q }); });
 afterEach(() => vi.restoreAllMocks());
 it("reports an unavailable opaque cookie session once without exposing its cause", async () => { const cause = new Error("private session store address"); mocks.session.mockRejectedValue(cause); const res = await request(app()).get(ROUTE); expect(res.status).toBe(503); expect(res.body).toEqual({ detail: "Auth session is unavailable" }); expect(res.text).not.toContain(cause.message); failure("auth.session_lookup_failed", cause); expect(mocks.upsert).not.toHaveBeenCalled(); });
 it("fails closed and reports an unavailable account tombstone store", async () => { const cause = new Error("private database address"); mocks.database.mockImplementation(() => { throw cause; }); const res = await request(app()).get(ROUTE).set("Authorization", "Bearer valid-local-token"); expect(res.status).toBe(503); expect(res.body).toEqual({ detail: "Account status is unavailable" }); failure("db.query_failed", cause); expect(mocks.upsert).not.toHaveBeenCalled(); });
 it("reports a profile initialization failure once and keeps its response opaque", async () => { const cause = new Error("private profile row"); mocks.upsert.mockRejectedValue(cause); const res = await request(app()).get(ROUTE).set("Authorization", "Bearer valid-local-token"); expect(res.status).toBe(500); expect(res.body).toEqual({ detail: "Unable to initialize user profile" }); expect(res.text).not.toContain(cause.message); failure("db.query_failed", cause); });
});
