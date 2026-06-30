import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import type { Request, Response, NextFunction } from "express";

vi.mock("../lib/supabase.js", () => ({
  createServerSupabase: vi.fn(),
}));

import { tenantAccess } from "./tenantAccess";
import { createServerSupabase } from "../lib/supabase.js";

type FakeRes = Response & {
  locals: Record<string, unknown>;
  statusCode: number;
  body: unknown;
};

function makeRes(principal?: Record<string, unknown> | null): FakeRes {
  const res = {
    locals: principal !== undefined ? { principal } : {},
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
  return res;
}

/**
 * Build a chainable fake of the supabase client whose terminator
 * (`maybeSingle()` for selects, `upsert()` for onboarding writes)
 * resolves to the provided result. Tracks calls so tests can assert on
 * the table / filter / payload.
 */
function makeAdmin(opts: {
  selectResult?: { data: unknown; error?: { message: string } | null };
  insertResult?: { error?: { message: string } | null };
}) {
  const calls: {
    from?: string;
    select?: string;
    eq?: [string, unknown];
    upsertPayload?: unknown;
    upsertOptions?: unknown;
  } = {};
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn((cols: string) => {
    calls.select = cols;
    return builder;
  });
  builder.eq = vi.fn((col: string, val: unknown) => {
    calls.eq = [col, val];
    return builder;
  });
  builder.maybeSingle = vi.fn(() =>
    Promise.resolve(
      opts.selectResult ?? { data: null, error: null },
    ),
  );
  builder.upsert = vi.fn((payload: unknown, options: unknown) => {
    calls.upsertPayload = payload;
    calls.upsertOptions = options;
    return Promise.resolve(opts.insertResult ?? { error: null });
  });
  const admin = {
    from: vi.fn((table: string) => {
      calls.from = table;
      return builder;
    }),
  };
  return { admin, calls, builder };
}

const PROVIDER_ENV = "AUTH_PROVIDER";
const ONBOARDING_ENV = "TENANT_ONBOARDING_MODE";
const ADMIN_GROUPS = "ENTRA_ADMIN_GROUP_IDS";
const MEMBER_GROUPS = "ENTRA_MEMBER_GROUP_IDS";
const envSnapshot = {} as Record<string, string | undefined>;

beforeEach(() => {
  for (const k of [PROVIDER_ENV, ONBOARDING_ENV, ADMIN_GROUPS, MEMBER_GROUPS]) {
    envSnapshot[k] = process.env[k];
  }
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of [PROVIDER_ENV, ONBOARDING_ENV, ADMIN_GROUPS, MEMBER_GROUPS]) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

describe("tenantAccess — provider gating", () => {
  it("is a no-op when AUTH_PROVIDER is not entra (default supabase)", async () => {
    delete process.env[PROVIDER_ENV];
    const res = makeRes(null);
    const next = vi.fn() as unknown as NextFunction;

    await tenantAccess({} as Request, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(createServerSupabase).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("is a no-op when AUTH_PROVIDER=local", async () => {
    process.env[PROVIDER_ENV] = "local";
    const res = makeRes(null);
    const next = vi.fn() as unknown as NextFunction;

    await tenantAccess({} as Request, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(createServerSupabase).not.toHaveBeenCalled();
  });
});

describe("tenantAccess — entra path, principal validation", () => {
  beforeEach(() => {
    process.env[PROVIDER_ENV] = "entra";
  });

  it("denies with TENANT_UNKNOWN and 403 when the principal has no tenantId", async () => {
    const res = makeRes({ userId: "u1", groups: [] });
    const next = vi.fn() as unknown as NextFunction;

    await tenantAccess({} as Request, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ detail: "TENANT_UNKNOWN" });
    expect(next).not.toHaveBeenCalled();
    expect(createServerSupabase).not.toHaveBeenCalled();
  });

  it("falls back to userId=\"unknown\" in the log when the principal is entirely absent", async () => {
    const res = makeRes(null);
    const next = vi.fn() as unknown as NextFunction;

    await tenantAccess({} as Request, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ detail: "TENANT_UNKNOWN" });
    expect(console.warn).toHaveBeenCalledWith(
      "auth.tenant_access_denied",
      expect.objectContaining({ userId: "unknown", reason: "TENANT_UNKNOWN" }),
    );
  });

  it("logs the denial with the user id and reason but never the token", async () => {
    const res = makeRes({ userId: "u1", groups: [] });
    const next = vi.fn() as unknown as NextFunction;

    await tenantAccess({} as Request, res, next);

    expect(console.warn).toHaveBeenCalledWith(
      "auth.tenant_access_denied",
      expect.objectContaining({
        userId: "u1",
        reason: "TENANT_UNKNOWN",
        tenantId: undefined,
        timestamp: expect.any(String),
      }),
    );
    const [, payload] = (console.warn as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0];
    expect(JSON.stringify(payload)).not.toMatch(/Bearer|secret|token/i);
  });
});

describe("tenantAccess — entra path, tenant lookup", () => {
  beforeEach(() => {
    process.env[PROVIDER_ENV] = "entra";
    process.env[ADMIN_GROUPS] = "admin-grp";
    process.env[MEMBER_GROUPS] = "member-grp";
  });

  it("returns 500 when the tenant query errors", async () => {
    const { admin } = makeAdmin({
      selectResult: { data: null, error: { message: "db down" } },
    });
    vi.mocked(createServerSupabase).mockReturnValue(
      admin as unknown as ReturnType<typeof createServerSupabase>,
    );
    const res = makeRes({ userId: "u1", tenantId: "t1", groups: ["member-grp"] });
    const next = vi.fn() as unknown as NextFunction;

    await tenantAccess({} as Request, res, next);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ detail: "Unable to evaluate tenant access" });
    expect(next).not.toHaveBeenCalled();
  });

  it("denies TENANT_UNKNOWN when the tenant row is missing and onboarding mode is manual", async () => {
    delete process.env[ONBOARDING_ENV];
    const { admin } = makeAdmin({ selectResult: { data: null } });
    vi.mocked(createServerSupabase).mockReturnValue(
      admin as unknown as ReturnType<typeof createServerSupabase>,
    );
    const res = makeRes({ userId: "u1", tenantId: "t-missing", groups: ["member-grp"] });
    const next = vi.fn() as unknown as NextFunction;

    await tenantAccess({} as Request, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ detail: "TENANT_UNKNOWN" });
    expect(next).not.toHaveBeenCalled();
  });

  it("auto-onboards a missing tenant when TENANT_ONBOARDING_MODE=auto and proceeds", async () => {
    process.env[ONBOARDING_ENV] = "auto";
    const { admin, calls } = makeAdmin({
      selectResult: { data: null },
      insertResult: { error: null },
    });
    vi.mocked(createServerSupabase).mockReturnValue(
      admin as unknown as ReturnType<typeof createServerSupabase>,
    );
    const principal = {
      userId: "u1",
      tenantId: "t-new",
      groups: ["member-grp"],
      roles: [] as string[],
    };
    const res = makeRes(principal);
    const next = vi.fn() as unknown as NextFunction;

    await tenantAccess({} as Request, res, next);

    expect(calls.upsertPayload).toEqual({
      tenant_id: "t-new",
      status: "active",
    });
    expect(calls.upsertOptions).toEqual({
      onConflict: "tenant_id",
      ignoreDuplicates: true,
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect((res.locals.principal as typeof principal).roles).toEqual(["Member"]);
  });

  it("returns 500 if auto-onboarding insert fails", async () => {
    process.env[ONBOARDING_ENV] = "auto";
    const { admin } = makeAdmin({
      selectResult: { data: null },
      insertResult: { error: { message: "unique violation" } },
    });
    vi.mocked(createServerSupabase).mockReturnValue(
      admin as unknown as ReturnType<typeof createServerSupabase>,
    );
    const res = makeRes({ userId: "u1", tenantId: "t-new", groups: ["member-grp"] });
    const next = vi.fn() as unknown as NextFunction;

    await tenantAccess({} as Request, res, next);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ detail: "Unable to onboard tenant" });
    expect(next).not.toHaveBeenCalled();
  });

  it("denies TENANT_PENDING when the tenant exists with status=pending", async () => {
    const { admin } = makeAdmin({
      selectResult: { data: { tenant_id: "t1", status: "pending" } },
    });
    vi.mocked(createServerSupabase).mockReturnValue(
      admin as unknown as ReturnType<typeof createServerSupabase>,
    );
    const res = makeRes({ userId: "u1", tenantId: "t1", groups: ["member-grp"] });
    const next = vi.fn() as unknown as NextFunction;

    await tenantAccess({} as Request, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ detail: "TENANT_PENDING" });
  });

  it("denies TENANT_SUSPENDED for any non-active, non-pending status", async () => {
    const { admin } = makeAdmin({
      selectResult: { data: { tenant_id: "t1", status: "suspended" } },
    });
    vi.mocked(createServerSupabase).mockReturnValue(
      admin as unknown as ReturnType<typeof createServerSupabase>,
    );
    const res = makeRes({ userId: "u1", tenantId: "t1", groups: ["member-grp"] });
    const next = vi.fn() as unknown as NextFunction;

    await tenantAccess({} as Request, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ detail: "TENANT_SUSPENDED" });
  });

  it("scopes the tenant query to the principal's tenantId (no cross-tenant lookup)", async () => {
    const { admin, calls } = makeAdmin({
      selectResult: { data: { tenant_id: "t-claim", status: "active" } },
    });
    vi.mocked(createServerSupabase).mockReturnValue(
      admin as unknown as ReturnType<typeof createServerSupabase>,
    );
    const res = makeRes({
      userId: "u1",
      tenantId: "t-claim",
      groups: ["member-grp"],
      roles: [],
    });
    const next = vi.fn() as unknown as NextFunction;

    await tenantAccess({} as Request, res, next);

    expect(calls.from).toBe("tenants");
    expect(calls.eq).toEqual(["tenant_id", "t-claim"]);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("tenantAccess — entra path, group → role mapping", () => {
  beforeEach(() => {
    process.env[PROVIDER_ENV] = "entra";
    const { admin } = makeAdmin({
      selectResult: { data: { tenant_id: "t1", status: "active" } },
    });
    vi.mocked(createServerSupabase).mockReturnValue(
      admin as unknown as ReturnType<typeof createServerSupabase>,
    );
  });

  it("denies GROUP_NOT_WHITELISTED when no configured group matches", async () => {
    process.env[ADMIN_GROUPS] = "admin-grp";
    process.env[MEMBER_GROUPS] = "member-grp";
    const res = makeRes({
      userId: "u1",
      tenantId: "t1",
      groups: ["random-group"],
    });
    const next = vi.fn() as unknown as NextFunction;

    await tenantAccess({} as Request, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ detail: "GROUP_NOT_WHITELISTED" });
    expect(next).not.toHaveBeenCalled();
  });

  it("denies GROUP_NOT_WHITELISTED when the principal has no groups claim at all", async () => {
    process.env[ADMIN_GROUPS] = "admin-grp";
    // A member-group allowlist must be configured: when it is empty the
    // promoted resolveRoles grants Member to anyone whose tenant is
    // already verified ("anyone in my tenant" default), so a missing
    // groups claim would NOT be denied. With a non-empty allowlist, a
    // principal with no groups matches nothing and is denied.
    process.env[MEMBER_GROUPS] = "member-grp";
    const res = makeRes({ userId: "u1", tenantId: "t1" });
    const next = vi.fn() as unknown as NextFunction;

    await tenantAccess({} as Request, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ detail: "GROUP_NOT_WHITELISTED" });
  });

  it("writes [TenantAdmin, Member] on principal.roles when an admin group matches", async () => {
    process.env[ADMIN_GROUPS] = "admin-grp";
    process.env[MEMBER_GROUPS] = "member-grp";
    const principal = {
      userId: "u1",
      tenantId: "t1",
      groups: ["admin-grp"],
      roles: [] as string[],
    };
    const res = makeRes(principal);
    const next = vi.fn() as unknown as NextFunction;

    await tenantAccess({} as Request, res, next);

    expect((res.locals.principal as typeof principal).roles).toEqual([
      "TenantAdmin",
      "Member",
    ]);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("writes [Member] when only the member group matches", async () => {
    process.env[ADMIN_GROUPS] = "admin-grp";
    process.env[MEMBER_GROUPS] = "member-grp";
    const principal = {
      userId: "u1",
      tenantId: "t1",
      groups: ["member-grp"],
      roles: [] as string[],
    };
    const res = makeRes(principal);
    const next = vi.fn() as unknown as NextFunction;

    await tenantAccess({} as Request, res, next);

    expect((res.locals.principal as typeof principal).roles).toEqual(["Member"]);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
