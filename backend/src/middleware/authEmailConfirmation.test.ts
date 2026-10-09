import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `res.locals.userEmail` is what every direct grant and organization
// invitation is matched against, so an address the account never confirmed
// must not reach it.
//
// Dev divergence (sync 1f831f07/d146998d): upstream's requireAuth reads the
// Supabase user directly. Dev's requireAuth is provider-pluggable
// (supabase | local | entra): the provider reports `emailVerified` on the
// principal and `authorizationEmail` decides what reaches res.locals. The
// providers, the profile mirror and tenant admission are mocked here so the
// test asserts only that decision.
const mocks = vi.hoisted(() => ({
  provider: "supabase" as string,
  validateSupabaseToken: vi.fn(),
  validateEntraToken: vi.fn(),
  upsertUserProfile: vi.fn(async () => undefined),
}));
vi.mock("../lib/config.js", () => ({
  getConfig: async () => mocks.provider,
}));
vi.mock("../lib/auth/providers/supabase.js", () => ({
  validateSupabaseToken: mocks.validateSupabaseToken,
}));
vi.mock("../lib/auth/providers/entra.js", () => ({
  validateEntraToken: mocks.validateEntraToken,
}));
vi.mock("../lib/userLookup.js", () => ({
  upsertUserProfile: mocks.upsertUserProfile,
}));
vi.mock("./tenantAccess.js", () => ({
  tenantAccess: async (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../lib/supabase.js", () => ({
  createServerSupabase: () => ({
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return builder;
    },
  }),
}));
import { requireAuth } from "./auth";

// The middleware is driven directly rather than mounted on an app: the
// behaviour under test is what it writes to res.locals.
async function authenticatedEmail(): Promise<unknown> {
  const req = {
    headers: { authorization: "Bearer token" },
    method: "GET",
    originalUrl: "/probe",
    get: () => undefined,
  } as unknown as Request;
  const res = {
    locals: {} as Record<string, unknown>,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  const next = vi.fn() as unknown as NextFunction;
  await requireAuth(req as never, res as unknown as Response, next);
  expect(res.status).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledOnce();
  return res.locals.userEmail;
}

function principal(overrides: Record<string, unknown>) {
  return {
    ok: true,
    principal: {
      userId: "u1",
      email: "person@example.com",
      groups: [],
      roles: [],
      provider: mocks.provider,
      ...overrides,
    },
  };
}

describe("requireAuth email trust", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.provider = "supabase";
  });

  it("exposes a confirmed email, normalized", async () => {
    mocks.validateSupabaseToken.mockResolvedValue(
      principal({ email: "Person@Example.com", emailVerified: true }),
    );
    expect(await authenticatedEmail()).toBe("person@example.com");
  });

  it("withholds an unconfirmed email so it matches no grant or invitation", async () => {
    mocks.validateSupabaseToken.mockResolvedValue(
      principal({ email: "victim@example.com", emailVerified: false }),
    );
    expect(await authenticatedEmail()).toBe("");
    // The session still authenticates and the profile mirror keeps the
    // IdP address for display; only grant matching is withheld.
    expect(mocks.upsertUserProfile).toHaveBeenCalledWith(
      "u1",
      "victim@example.com",
      undefined,
    );
  });

  it("exposes the tenant-administered Entra email", async () => {
    mocks.provider = "entra";
    mocks.validateEntraToken.mockResolvedValue(
      principal({ email: "person@contoso.example" }),
    );
    expect(await authenticatedEmail()).toBe("person@contoso.example");
  });
});
