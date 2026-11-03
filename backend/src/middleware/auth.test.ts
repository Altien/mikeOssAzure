import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

vi.mock("../lib/auth/providers/supabase.js", () => ({
  validateSupabaseToken: vi.fn(),
}));
vi.mock("../lib/auth/providers/local.js", () => ({
  validateLocalToken: vi.fn(),
}));
vi.mock("../lib/auth/providers/entra.js", () => ({
  validateEntraToken: vi.fn(),
}));
vi.mock("./tenantAccess.js", () => ({
  tenantAccess: vi.fn(),
}));
vi.mock("../lib/userLookup.js", () => ({
  upsertUserProfile: vi.fn(),
}));
vi.mock("../lib/supabase.js", () => ({
  createServerSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
    }),
  }),
}));
vi.mock("../lib/serverSession.js", () => ({ readServerSession: vi.fn(), refreshServerSession: vi.fn() }));
vi.mock("../lib/auth/providers/entraRefresh.js", () => ({ renewEntraCredential: vi.fn() }));
vi.mock("../lib/auth/providers/supabaseSession.js", () => ({ renewSupabaseCredential: vi.fn() }));
// Multi-tenant 017: only the bucket call is faked; limits still read env.
vi.mock("../lib/tenantRateLimit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tenantRateLimit.js")>()),
  takeTenantTokens: vi.fn(async () => ({ allowed: true, retryAfterMs: 0 })),
}));

// Dev exports only requireAuth — the mirror's requireValidJwt (auth
// without tenantAccess) never landed here.
import { requireAuth } from "./auth";
import { validateSupabaseToken } from "../lib/auth/providers/supabase.js";
import { validateLocalToken } from "../lib/auth/providers/local.js";
import { validateEntraToken } from "../lib/auth/providers/entra.js";
import { tenantAccess } from "./tenantAccess.js";
import { upsertUserProfile } from "../lib/userLookup.js";
import { readServerSession, refreshServerSession } from "../lib/serverSession.js";
import { currentTenant } from "../lib/tenantContext.js";
import { takeTenantTokens } from "../lib/tenantRateLimit.js";

type FakeRes = Response & {
  locals: Record<string, unknown>;
  statusCode: number;
  body: unknown;
};

function makeReq(authHeader?: string): Request {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
    method: "GET",
    get: () => undefined,
  } as unknown as Request;
}

function makeRes(): FakeRes {
  const res = {
    locals: {} as Record<string, unknown>,
    statusCode: 200,
    body: undefined as unknown,
  } as FakeRes;
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as FakeRes["status"];
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  }) as FakeRes["json"];
  res.setHeader = vi.fn() as FakeRes["setHeader"];
  return res;
}

const validPrincipal = {
  userId: "user-123",
  email: "caller@example.com",
  displayName: "Caller",
  groups: [],
  roles: [],
  provider: "supabase",
};

let originalAuthProvider: string | undefined;

beforeEach(() => {
  originalAuthProvider = process.env.AUTH_PROVIDER;
  vi.mocked(readServerSession).mockReset().mockResolvedValue(null);
});

afterEach(() => {
  if (originalAuthProvider === undefined) {
    delete process.env.AUTH_PROVIDER;
  } else {
    process.env.AUTH_PROVIDER = originalAuthProvider;
  }
});

describe("requireAuth — header handling", () => {
  it("returns 401 when the Authorization header is missing", async () => {
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      detail: "Invalid or expired session",
    });
    expect(next).not.toHaveBeenCalled();
    expect(tenantAccess).not.toHaveBeenCalled();
  });

  it("returns 401 when the Authorization header is not a Bearer token", async () => {
    const req = makeReq("Basic abc123");
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(validateSupabaseToken).not.toHaveBeenCalled();
  });
});

describe("requireAuth — opaque cookie boundary", () => {
  beforeEach(() => {
    process.env.AUTH_PROVIDER = "supabase";
    process.env.FRONTEND_URL = "https://web.example.test";
    vi.mocked(validateSupabaseToken).mockResolvedValue({ ok: true, principal: validPrincipal });
    vi.mocked(upsertUserProfile).mockResolvedValue(undefined);
    vi.mocked(tenantAccess).mockImplementation(async (_req, _res, next) => next());
    vi.mocked(readServerSession).mockResolvedValue({
      row: { token_expires_at: new Date(Date.now() + 3600_000).toISOString() },
      credential: { provider: "supabase", userId: validPrincipal.userId, accessToken: "server-held", refreshToken: "server-refresh" },
    } as Awaited<ReturnType<typeof readServerSession>>);
  });

  it("never falls back to a cookie after an explicit bad Authorization header", async () => {
    const req = makeReq("Bearer ");
    const res = makeRes();
    await requireAuth(req, res, vi.fn());
    expect(res.statusCode).toBe(401);
    expect(readServerSession).not.toHaveBeenCalled();
  });

  it("validates the provider identity from the server-held cookie on every request", async () => {
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();
    await requireAuth(req, res, next);
    expect(validateSupabaseToken).toHaveBeenCalledWith("server-held");
    expect(res.locals.authSource).toBe("cookie");
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects a cookie-authenticated write from an untrusted Origin", async () => {
    const req = makeReq();
    req.method = "POST";
    // Dev drift: double cast for the tsconfig.test.json type-check gate.
    req.get = vi.fn(() => "https://attacker.example") as unknown as Request["get"];
    const res = makeRes();
    await requireAuth(req, res, vi.fn());
    expect(res.statusCode).toBe(403);
    expect(readServerSession).not.toHaveBeenCalled();
  });

  it("rejects a cookie whose live provider identity differs from its persisted text user ID", async () => {
    vi.mocked(readServerSession).mockResolvedValueOnce({
      row: { token_expires_at: new Date(Date.now() + 3600_000).toISOString() },
      credential: { provider: "supabase", userId: "another-user", accessToken: "server-held" },
    } as Awaited<ReturnType<typeof readServerSession>>);
    const res = makeRes();
    await requireAuth(makeReq(), res, vi.fn());
    expect(res.statusCode).toBe(401);
  });

  it("uses the winner's credential when another replica wins the refresh CAS", async () => {
    vi.mocked(readServerSession)
      .mockResolvedValueOnce({
        row: { version: 3, token_expires_at: new Date(Date.now() - 1000).toISOString() },
        credential: { provider: "supabase", userId: validPrincipal.userId, accessToken: "expired", refreshToken: "old-refresh" },
      } as Awaited<ReturnType<typeof readServerSession>>)
      .mockResolvedValueOnce({
        row: { version: 4, token_expires_at: new Date(Date.now() + 3600_000).toISOString() },
        credential: { provider: "supabase", userId: validPrincipal.userId, accessToken: "winner-token", refreshToken: "winner-refresh" },
      } as Awaited<ReturnType<typeof readServerSession>>);
    vi.mocked(refreshServerSession).mockResolvedValueOnce(false);
    const res = makeRes();
    const next = vi.fn();
    await requireAuth(makeReq(), res, next);
    expect(validateSupabaseToken).toHaveBeenCalledWith("winner-token");
    expect(res.locals.token).toBe("winner-token");
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("requireAuth — provider routing", () => {
  it("uses the supabase provider by default", async () => {
    delete process.env.AUTH_PROVIDER;
    vi.mocked(validateSupabaseToken).mockResolvedValue({
      ok: true,
      // Dev drift: the validator result has no authSource; requireAuth sets it.
      principal: validPrincipal,
    });
    vi.mocked(upsertUserProfile).mockResolvedValue(undefined);
    vi.mocked(tenantAccess).mockImplementation(async (_req, _res, next) => {
      next();
    });

    const req = makeReq("Bearer tok-supa");
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res, next);

    expect(validateSupabaseToken).toHaveBeenCalledWith("tok-supa");
    expect(validateLocalToken).not.toHaveBeenCalled();
    expect(validateEntraToken).not.toHaveBeenCalled();
  });

  it("uses the local provider when AUTH_PROVIDER=local", async () => {
    process.env.AUTH_PROVIDER = "local";
    vi.mocked(validateLocalToken).mockResolvedValue({
      ok: true,
      principal: validPrincipal,
    });
    vi.mocked(upsertUserProfile).mockResolvedValue(undefined);
    vi.mocked(tenantAccess).mockImplementation(async (_req, _res, next) => {
      next();
    });

    const req = makeReq("Bearer tok-local");
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res, next);

    expect(validateLocalToken).toHaveBeenCalledWith("tok-local");
    expect(validateSupabaseToken).not.toHaveBeenCalled();
  });

  it("uses the entra provider when AUTH_PROVIDER=entra", async () => {
    process.env.AUTH_PROVIDER = "entra";
    vi.mocked(validateEntraToken).mockResolvedValue({
      ok: true,
      principal: validPrincipal,
    });
    vi.mocked(upsertUserProfile).mockResolvedValue(undefined);
    vi.mocked(tenantAccess).mockImplementation(async (_req, _res, next) => {
      next();
    });

    const req = makeReq("Bearer tok-entra");
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res, next);

    expect(validateEntraToken).toHaveBeenCalledWith("tok-entra");
  });

  it("returns 500 when AUTH_PROVIDER is set to an unknown value", async () => {
    process.env.AUTH_PROVIDER = "bogus";

    const req = makeReq("Bearer tok");
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res, next);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      detail: "Auth provider 'bogus' is not yet implemented",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("trims surrounding whitespace from the token before validation", async () => {
    delete process.env.AUTH_PROVIDER;
    vi.mocked(validateSupabaseToken).mockResolvedValue({
      ok: true,
      principal: validPrincipal,
    });
    vi.mocked(upsertUserProfile).mockResolvedValue(undefined);
    vi.mocked(tenantAccess).mockImplementation(async (_req, _res, next) => {
      next();
    });

    const req = makeReq("Bearer    tok-padded   ");
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res, next);

    expect(validateSupabaseToken).toHaveBeenCalledWith("tok-padded");
  });
});

describe("requireAuth — validation failures", () => {
  it("forwards the provider's status and detail when validation fails", async () => {
    delete process.env.AUTH_PROVIDER;
    vi.mocked(validateSupabaseToken).mockResolvedValue({
      ok: false,
      status: 401,
      detail: "Token expired",
    });

    const req = makeReq("Bearer tok-bad");
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ detail: "Token expired" });
    expect(upsertUserProfile).not.toHaveBeenCalled();
    expect(tenantAccess).not.toHaveBeenCalled();
  });

  it("forwards a 403 from the provider unchanged", async () => {
    delete process.env.AUTH_PROVIDER;
    vi.mocked(validateSupabaseToken).mockResolvedValue({
      ok: false,
      status: 403,
      detail: "User disabled",
    });

    const req = makeReq("Bearer tok-bad");
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ detail: "User disabled" });
  });
});

describe("requireAuth — success path", () => {
  beforeEach(() => {
    delete process.env.AUTH_PROVIDER;
    vi.mocked(validateSupabaseToken).mockResolvedValue({
      ok: true,
      principal: validPrincipal,
    });
    vi.mocked(upsertUserProfile).mockResolvedValue(undefined);
    vi.mocked(tenantAccess).mockImplementation(async (_req, _res, next) => {
      next();
    });
  });

  it("populates res.locals with the principal, token, userId and email", async () => {
    const req = makeReq("Bearer tok-ok");
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res, next);

    expect(res.locals).toEqual({
      userId: "user-123",
      userEmail: "caller@example.com",
      token: "tok-ok",
      authSource: "bearer",
      principal: validPrincipal,
    });
  });

  it("upserts the user profile with the principal's id, email, and display name", async () => {
    const req = makeReq("Bearer tok-ok");
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res, next);

    expect(upsertUserProfile).toHaveBeenCalledWith(
      "user-123",
      "caller@example.com",
      "Caller",
    );
  });

  it("hands off to tenantAccess after a successful validation", async () => {
    const req = makeReq("Bearer tok-ok");
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res, next);

    // 012 admits the tenant before profile initialization, then reaches the handler.
    expect(tenantAccess).toHaveBeenCalledWith(req, res, expect.any(Function));
    expect(next).toHaveBeenCalledOnce();
  });

  it("returns a generic 500 when profile initialization fails", async () => {
    vi.mocked(upsertUserProfile).mockRejectedValueOnce(
      new Error("db unreachable"),
    );

    const req = makeReq("Bearer tok-ok");
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res, next);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ detail: "Unable to initialize user profile" });
    // 012 admission precedes the profile write; a failed write still blocks the handler.
    expect(tenantAccess).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 500 with a generic detail when upsertUserProfile throws a non-Error", async () => {
    vi.mocked(upsertUserProfile).mockRejectedValueOnce("boom-string");

    const req = makeReq("Bearer tok-ok");
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireAuth(req, res, next);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ detail: "Unable to initialize user profile" });
  });
});


// Multi-tenant phase 1 (docs/issues/multi-tenant/001): the tenant is resolved
// from the validated principal and is visible to every awaited call made by
// tenantAccess and the handler next() reaches — never from request input.
describe("requireAuth — tenant context", () => {
  const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(() => {
    vi.mocked(upsertUserProfile).mockResolvedValue(undefined);
    vi.mocked(tenantAccess).mockImplementation(async (_req, _res, next) => next());
  });

  it("entra: handlers and their awaited services see the token's tid", async () => {
    process.env.AUTH_PROVIDER = "entra";
    vi.mocked(validateEntraToken).mockResolvedValue({
      ok: true,
      principal: { ...validPrincipal, provider: "entra", tenantId: "tid-a" },
    });
    let seen: unknown;
    const next = vi.fn(async () => {
      await tick(1);
      seen = currentTenant();
    }) as unknown as NextFunction;
    await requireAuth(makeReq("Bearer t"), makeRes(), next);
    await vi.waitFor(() => expect(seen).toEqual({ tenantId: "tid-a", userId: validPrincipal.userId }));
    expect(currentTenant()).toBeUndefined();
  });

  it("local: uses the configured default key, not request input", async () => {
    process.env.AUTH_PROVIDER = "local";
    vi.mocked(validateLocalToken).mockResolvedValue({ ok: true, principal: { ...validPrincipal, provider: "local" } });
    let seen: unknown;
    const req = makeReq("Bearer t");
    (req.headers as Record<string, string>)["x-tenant-id"] = "spoofed";
    const next = vi.fn(() => { seen = currentTenant()?.tenantId; }) as unknown as NextFunction;
    await requireAuth(req, makeRes(), next);
    expect(seen).toBe("default");
  });

  it("two concurrent requests with different tenants never observe each other", async () => {
    process.env.AUTH_PROVIDER = "entra";
    vi.mocked(validateEntraToken).mockImplementation(async (token: string) => ({
      ok: true,
      principal: { ...validPrincipal, userId: `user-${token}`, provider: "entra", tenantId: `tid-${token}` },
    }));
    const seen: Record<string, string[]> = { a: [], b: [] };
    const run = (name: "a" | "b", delays: number[]) =>
      new Promise<void>((resolve) => {
        const next = (async () => {
          for (const delay of delays) {
            await tick(delay);
            seen[name].push(`${currentTenant()?.tenantId}/${currentTenant()?.userId}`);
          }
          resolve();
        }) as unknown as NextFunction;
        void requireAuth(makeReq(`Bearer ${name}`), makeRes(), next);
      });
    await Promise.all([run("a", [4, 1, 6]), run("b", [1, 5, 1])]);
    expect(seen.a).toEqual(Array(3).fill("tid-a/user-a"));
    expect(seen.b).toEqual(Array(3).fill("tid-b/user-b"));
  });

  it("entra without tid: no context, tenantAccess decides", async () => {
    process.env.AUTH_PROVIDER = "entra";
    vi.mocked(validateEntraToken).mockResolvedValue({ ok: true, principal: { ...validPrincipal, provider: "entra" } });
    let seen: unknown = "unset";
    vi.mocked(tenantAccess).mockImplementation(async () => { seen = currentTenant(); });
    await requireAuth(makeReq("Bearer t"), makeRes(), vi.fn() as unknown as NextFunction);
    expect(seen).toBeUndefined();
  });
});

describe("requireAuth — shared tenant request limit (issue 017)", () => {
  beforeEach(() => {
    process.env.AUTH_PROVIDER = "local";
    vi.mocked(validateLocalToken).mockResolvedValue({ ok: true, principal: { ...validPrincipal, provider: "local" } });
    vi.mocked(upsertUserProfile).mockResolvedValue(undefined);
    vi.mocked(tenantAccess).mockImplementation(async (_req, _res, next) => next());
    vi.mocked(takeTenantTokens).mockReset().mockResolvedValue({ allowed: true, retryAfterMs: 0 });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is off by default: no bucket call", async () => {
    const next = vi.fn() as unknown as NextFunction;
    await requireAuth(makeReq("Bearer t"), makeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(takeTenantTokens).not.toHaveBeenCalled();
  });

  it("takes one token from the tenant's requests bucket after tenant admission", async () => {
    vi.stubEnv("TENANT_REQUESTS_PER_MINUTE", "600");
    let tenantAtTake: unknown;
    vi.mocked(takeTenantTokens).mockImplementation(async () => {
      tenantAtTake = currentTenant()?.tenantId;
      return { allowed: true, retryAfterMs: 0 };
    });
    const next = vi.fn() as unknown as NextFunction;
    await requireAuth(makeReq("Bearer t"), makeRes(), next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledWith());
    expect(takeTenantTokens).toHaveBeenCalledWith("requests", 1, 600);
    expect(tenantAtTake).toBe("default");
  });

  it("answers 429 with Retry-After when the bucket is empty", async () => {
    vi.stubEnv("TENANT_REQUESTS_PER_MINUTE", "600");
    vi.mocked(takeTenantTokens).mockResolvedValue({ allowed: false, retryAfterMs: 2500 });
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    await requireAuth(makeReq("Bearer t"), res, next);
    await vi.waitFor(() => expect(res.statusCode).toBe(429));
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "3");
    expect(res.body).toEqual({ detail: "Too many requests for your organisation. Please try again later." });
    expect(next).not.toHaveBeenCalled();
  });
});
