import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requireRole } from "./requireRole";

type FakeRes = Response & {
  locals: Record<string, unknown>;
  statusCode: number;
  body: unknown;
};

function makeRes(locals: Record<string, unknown> = {}): FakeRes {
  const res = {
    locals,
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

describe("requireRole", () => {
  it("allows the request through when the principal has the required role", () => {
    const mw = requireRole("Member");
    const res = makeRes({ principal: { roles: ["Member"] } });
    const next = vi.fn() as unknown as NextFunction;

    mw({} as Request, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("treats TenantAdmin as a distinct role — requiring Member is satisfied by Member only", () => {
    const mw = requireRole("Member");
    const res = makeRes({ principal: { roles: ["TenantAdmin"] } });
    const next = vi.fn() as unknown as NextFunction;

    mw({} as Request, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ detail: "ROLE_REQUIRED" });
    expect(next).not.toHaveBeenCalled();
  });

  it("denies with 403 ROLE_REQUIRED when the role is absent from principal.roles", () => {
    const mw = requireRole("TenantAdmin");
    const res = makeRes({ principal: { roles: ["Member"] } });
    const next = vi.fn() as unknown as NextFunction;

    mw({} as Request, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ detail: "ROLE_REQUIRED" });
    expect(next).not.toHaveBeenCalled();
  });

  it("denies when the principal is missing entirely — no `null` blow-up", () => {
    const mw = requireRole("Member");
    const res = makeRes({});
    const next = vi.fn() as unknown as NextFunction;

    expect(() => mw({} as Request, res, next)).not.toThrow();
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("denies when the principal has no roles array (e.g. tenantAccess never ran)", () => {
    const mw = requireRole("Member");
    const res = makeRes({ principal: { userId: "u1" } });
    const next = vi.fn() as unknown as NextFunction;

    mw({} as Request, res, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("denies when roles is an empty array", () => {
    const mw = requireRole("Member");
    const res = makeRes({ principal: { roles: [] as string[] } });
    const next = vi.fn() as unknown as NextFunction;

    mw({} as Request, res, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns a fresh handler per call so two different roles don't interfere", () => {
    const memberMw = requireRole("Member");
    const adminMw = requireRole("TenantAdmin");

    const res1 = makeRes({ principal: { roles: ["Member"] } });
    const next1 = vi.fn() as unknown as NextFunction;
    memberMw({} as Request, res1, next1);
    expect(next1).toHaveBeenCalledTimes(1);

    const res2 = makeRes({ principal: { roles: ["Member"] } });
    const next2 = vi.fn() as unknown as NextFunction;
    adminMw({} as Request, res2, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(res2.statusCode).toBe(403);
  });

  it("is case-sensitive — \"member\" does not satisfy a requirement of \"Member\"", () => {
    const mw = requireRole("Member");
    const res = makeRes({ principal: { roles: ["member"] } });
    const next = vi.fn() as unknown as NextFunction;

    mw({} as Request, res, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});
