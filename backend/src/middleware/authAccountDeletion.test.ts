// Dev drift: account erasure is a durable tombstone checked after provider validation.
import type { Request, Response } from "express";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ status: vi.fn(), upsert: vi.fn() }));
vi.mock("../lib/config", () => ({ getConfig: vi.fn(async () => "local") }));
vi.mock("../lib/auth/providers/local.js", () => ({ validateLocalToken: vi.fn(async () => ({ ok: true, principal: { userId: "u", email: "u@example.test", emailVerified: true, provider: "local" } })) }));
vi.mock("../lib/userLookup", () => ({ upsertUserProfile: mocks.upsert }));
vi.mock("../lib/supabase", () => ({ createServerSupabase: () => ({ from: () => { const q = { select: () => q, eq: () => q, maybeSingle: mocks.status }; return q; } }) }));
import { requireAuth } from "./auth";
beforeEach(() => vi.clearAllMocks());
it.each([
 [{ data: { status: "pending" }, error: null }, 410],
 [{ data: null, error: { message: "database unavailable" } }, 503],
])("blocks an erasure tombstone and fails closed when its status is unavailable", async (result, status) => {
 mocks.status.mockResolvedValue(result);
 const req = { headers: { authorization: "Bearer valid-token" }, method: "GET", originalUrl: "/api/projects" } as Request;
 const res = { locals: {}, status: vi.fn().mockReturnThis(), json: vi.fn() }; const next = vi.fn();
 await requireAuth(req, res as unknown as Response, next);
 expect(res.status).toHaveBeenCalledWith(status); expect(next).not.toHaveBeenCalled(); expect(mocks.upsert).not.toHaveBeenCalled(); expect(res.locals).toEqual({});
});
