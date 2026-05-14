import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

const { getUser, createClient } = vi.hoisted(() => {
  const getUserFn = vi.fn();
  return {
    getUser: getUserFn,
    createClient: vi.fn(() => ({ auth: { getUser: getUserFn } })),
  };
});

vi.mock("@supabase/supabase-js", () => ({ createClient }));

import { validateSupabaseToken } from "./supabase";

const URL_ENV = "SUPABASE_URL";
const KEY_ENV = "SUPABASE_SECRET_KEY";
const envSnapshot = {} as Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot[URL_ENV] = process.env[URL_ENV];
  envSnapshot[KEY_ENV] = process.env[KEY_ENV];
});

afterEach(() => {
  for (const k of [URL_ENV, KEY_ENV]) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

describe("validateSupabaseToken — configuration", () => {
  it("rejects with 401 'Server auth is not configured' when SUPABASE_URL is empty", async () => {
    delete process.env[URL_ENV];
    process.env[KEY_ENV] = "secret";

    const result = await validateSupabaseToken("tok");

    expect(result).toEqual({
      ok: false,
      status: 401,
      detail: "Server auth is not configured",
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("rejects with 401 'Server auth is not configured' when SUPABASE_SECRET_KEY is empty", async () => {
    process.env[URL_ENV] = "https://x.supabase.co";
    delete process.env[KEY_ENV];

    const result = await validateSupabaseToken("tok");

    expect(result).toEqual({
      ok: false,
      status: 401,
      detail: "Server auth is not configured",
    });
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("validateSupabaseToken — token validation", () => {
  beforeEach(() => {
    process.env[URL_ENV] = "https://x.supabase.co";
    process.env[KEY_ENV] = "service-role-key";
  });

  it("constructs the admin client with persistSession=false (no cookie/session leakage)", async () => {
    getUser.mockResolvedValueOnce({ data: { user: null } });

    await validateSupabaseToken("tok");

    expect(createClient).toHaveBeenCalledWith(
      "https://x.supabase.co",
      "service-role-key",
      { auth: { persistSession: false } },
    );
  });

  it("forwards the token to supabase.auth.getUser", async () => {
    getUser.mockResolvedValueOnce({ data: { user: null } });

    await validateSupabaseToken("the-token");

    expect(getUser).toHaveBeenCalledWith("the-token");
  });

  it("rejects with 401 'Invalid or expired token' when supabase returns no user", async () => {
    getUser.mockResolvedValueOnce({ data: { user: null } });

    const result = await validateSupabaseToken("tok");

    expect(result).toEqual({
      ok: false,
      status: 401,
      detail: "Invalid or expired token",
    });
  });

  it("returns a fully-populated principal on success", async () => {
    getUser.mockResolvedValueOnce({
      data: { user: { id: "user-123", email: "Caller@Example.com" } },
    });

    const result = await validateSupabaseToken("tok");

    expect(result).toEqual({
      ok: true,
      principal: {
        userId: "user-123",
        email: "caller@example.com",
        groups: [],
        roles: [],
        provider: "supabase",
      },
    });
  });

  it("substitutes an empty string when the user has no email", async () => {
    getUser.mockResolvedValueOnce({
      data: { user: { id: "user-123" } },
    });

    const result = await validateSupabaseToken("tok");

    expect(result).toEqual({
      ok: true,
      principal: expect.objectContaining({ email: "" }),
    });
  });

  it("never leaks the service key into the principal", async () => {
    getUser.mockResolvedValueOnce({
      data: { user: { id: "user-123", email: "a@b.c" } },
    });

    const result = await validateSupabaseToken("tok");

    expect(JSON.stringify(result)).not.toContain("service-role-key");
  });
});
