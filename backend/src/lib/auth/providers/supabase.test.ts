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
      data: {
        user: {
          id: "user-123",
          email: "Caller@Example.com",
          email_confirmed_at: "2026-01-01T00:00:00Z",
        },
      },
    });

    const result = await validateSupabaseToken("tok");

    expect(result).toEqual({
      ok: true,
      principal: {
        userId: "user-123",
        email: "caller@example.com",
        emailVerified: true,
        groups: [],
        roles: [],
        provider: "supabase",
      },
    });
  });

  // Sync d146998d: grant/invitation matching ignores an unconfirmed address,
  // so the provider reports whether Supabase confirmed it.
  it("reports an unconfirmed email as not verified", async () => {
    getUser.mockResolvedValueOnce({
      data: { user: { id: "user-123", email: "victim@example.com", email_confirmed_at: null } },
    });

    const result = await validateSupabaseToken("tok");

    expect(result).toEqual({
      ok: true,
      principal: expect.objectContaining({
        email: "victim@example.com",
        emailVerified: false,
      }),
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

// Upstream 156d0fde, adapted: classify a failed lookup from the error getUser returns.
describe("validateSupabaseToken — failure classification", () => {
  beforeEach(() => {
    process.env[URL_ENV] = "https://x.supabase.co";
    process.env[KEY_ENV] = "service-role-key";
  });
  const authJsError = (name: string, status: number) =>
    Object.assign(new Error("gotrue"), { __isAuthError: true, name, status });

  it("answers a session GoTrue refused (4xx AuthApiError) with 401 session_expired", async () => {
    getUser.mockResolvedValueOnce({ data: { user: null }, error: authJsError("AuthApiError", 403) });
    expect(await validateSupabaseToken("tok")).toEqual({
      ok: false, status: 401, detail: "Invalid or expired session", code: "session_expired",
    });
  });

  it("answers a GoTrue 500 with a 500 carrying the failure, not a sign-out", async () => {
    const error = authJsError("AuthApiError", 500);
    getUser.mockResolvedValueOnce({ data: { user: null }, error });
    expect(await validateSupabaseToken("tok")).toMatchObject({ ok: false, status: 500, failure: error });
  });

  it("keeps the 503 for an unreachable GoTrue, never session_expired", async () => {
    getUser.mockResolvedValueOnce({ data: { user: null }, error: authJsError("AuthRetryableFetchError", 503) });
    expect(await validateSupabaseToken("tok")).toMatchObject({ ok: false, status: 503 });
  });

  it("keeps the plain 401 when there is no session at all", async () => {
    getUser.mockResolvedValueOnce({ data: { user: null }, error: authJsError("AuthSessionMissingError", 400) });
    expect(await validateSupabaseToken("tok")).toEqual({ ok: false, status: 401, detail: "Invalid or expired token" });
  });
});
