import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `res.locals.userEmail` is what every direct grant and organization
// invitation is matched against, so an address the account never confirmed
// must not reach it.
const mocks = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("../lib/userLookup", () => ({ syncProfileEmail: async () => null }));
vi.mock("../lib/supabase", () => ({
  createServerSupabase: () => ({
    auth: { getUser: mocks.getUser },
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

function app() {
  const server = express();
  server.get("/probe", requireAuth, (_req, res) =>
    res.json({ email: res.locals.userEmail }),
  );
  return server;
}

describe("requireAuth email trust", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exposes a confirmed email, normalized", async () => {
    mocks.getUser.mockResolvedValue({
      data: {
        user: {
          id: "u1",
          email: "Person@Example.com",
          email_confirmed_at: "2026-01-01T00:00:00Z",
        },
      },
      error: null,
    });
    const res = await request(app())
      .get("/probe")
      .set("Authorization", "Bearer token");
    expect(res.status).toBe(200);
    expect(res.body.email).toBe("person@example.com");
  });

  it("withholds an unconfirmed email so it matches no grant or invitation", async () => {
    mocks.getUser.mockResolvedValue({
      data: {
        user: { id: "u1", email: "victim@example.com", email_confirmed_at: null },
      },
      error: null,
    });
    const res = await request(app())
      .get("/probe")
      .set("Authorization", "Bearer token");
    expect(res.status).toBe(200);
    expect(res.body.email).toBe("");
  });
});
