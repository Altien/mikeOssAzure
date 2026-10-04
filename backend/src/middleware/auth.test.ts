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
vi.mock("../lib/userSettings.js", () => ({
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

// Dev exports only requireAuth — the mirror's requireValidJwt (auth
// without tenantAccess) never landed here.
import { requireAuth } from "./auth";
import { validateSupabaseToken } from "../lib/auth/providers/supabase.js";
import { validateLocalToken } from "../lib/auth/providers/local.js";
import { validateEntraToken } from "../lib/auth/providers/entra.js";
import { tenantAccess } from "./tenantAccess.js";
import { upsertUserProfile } from "../lib/userSettings.js";
import { readServerSession, refreshServerSession } from "../lib/serverSession.js";

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
    req.get = vi.fn(() => "https://attacker.example") as Request["get"];
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
      principal: validPrincipal,
      authSource: "bearer",
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

    expect(tenantAccess).toHaveBeenCalledWith(req, res, next);
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
    expect(tenantAccess).not.toHaveBeenCalled();
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
