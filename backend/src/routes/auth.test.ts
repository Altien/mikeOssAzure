import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import request from "supertest";
import { createHmac, createHash } from "node:crypto";
import { makeApp } from "../test/helpers/buildTestApp";

// ── Env-isolation harness ────────────────────────────────────────────────
// authRouter reads many env vars at request time. Snapshot every var it
// touches before each test, scrub them, restore on teardown so cases
// don't leak into each other.
const TOUCHED_ENV = [
  "AUTH_PROVIDER",
  "AUTH_STATE_SECRET",
  "JWT_SECRET",
  "FRONTEND_URL",
  "BACKEND_PUBLIC_URL",
  "ENTRA_TENANT_ID",
  "ENTRA_CLIENT_ID",
  "ENTRA_FRONTEND_CLIENT_ID",
  "ENTRA_CLIENT_SECRET",
  "ENTRA_BACKEND_CLIENT_ID",
  "ENTRA_AUTH_SCOPES",
  "ENTRA_BACKEND_SCOPE",
  "ENTRA_REDIRECT_URI",
  "NODE_ENV",
] as const;

const envSnapshot = {} as Record<string, string | undefined>;

beforeEach(() => {
  for (const k of TOUCHED_ENV) envSnapshot[k] = process.env[k];
  for (const k of TOUCHED_ENV) delete process.env[k];
  process.env.NODE_ENV = "test";
  process.env.FRONTEND_URL = "https://app.example.com";
});

afterEach(() => {
  for (const k of TOUCHED_ENV) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  vi.unstubAllGlobals();
});

// ── /local-login ─────────────────────────────────────────────────────────

describe("POST /api/auth/local-login", () => {
  it("returns 404 when AUTH_PROVIDER is not local", async () => {
    process.env.AUTH_PROVIDER = "supabase";

    const res = await request(makeApp())
      .post("/api/auth/local-login")
      .send({ email: "x@y.z" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      detail: "Local login is only available when AUTH_PROVIDER=local",
    });
  });

  it("returns 500 when AUTH_PROVIDER=local but JWT_SECRET is missing (refuses to mint with weak/empty secret)", async () => {
    process.env.AUTH_PROVIDER = "local";

    const res = await request(makeApp())
      .post("/api/auth/local-login")
      .send({ email: "x@y.z" });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      detail: "JWT_SECRET is required for local login",
    });
  });

  it("mints an HS256 token whose payload includes the requested email and a valid exp", async () => {
    const SECRET = "test-jwt-secret-32-chars-or-longer";
    process.env.AUTH_PROVIDER = "local";
    process.env.JWT_SECRET = SECRET;

    const res = await request(makeApp())
      .post("/api/auth/local-login")
      .send({ email: "  Caller@Example.COM  " });

    expect(res.status).toBe(200);
    const parts = (res.body.token as string).split(".");
    expect(parts).toHaveLength(3);

    // The signature must verify against the configured secret.
    const expected = createHmac("sha256", SECRET)
      .update(`${parts[0]}.${parts[1]}`)
      .digest("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    expect(parts[2]).toBe(expected);

    // The payload claims should round-trip the lowercased+trimmed email.
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64")
        .toString("utf8"),
    ) as { sub: string; email: string; exp: number; iat: number; role: string };
    expect(payload.email).toBe("caller@example.com");
    expect(payload.role).toBe("authenticated");
    expect(payload.exp).toBeGreaterThan(payload.iat);
    // 8h token.
    expect(payload.exp - payload.iat).toBe(8 * 60 * 60);

    // user.id is a deterministic UUID-shaped hash of the lowercased email.
    const expectedHex = createHash("sha256").update("caller@example.com").digest("hex");
    const expectedId =
      `${expectedHex.slice(0, 8)}-${expectedHex.slice(8, 12)}-4${expectedHex.slice(13, 16)}-a${expectedHex.slice(17, 20)}-${expectedHex.slice(20, 32)}`;
    expect(res.body.user).toEqual({
      id: expectedId,
      email: "caller@example.com",
    });
  });

  it("falls back to a default email when the body lacks one", async () => {
    process.env.AUTH_PROVIDER = "local";
    process.env.JWT_SECRET = "secret";

    const res = await request(makeApp()).post("/api/auth/local-login").send({});

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("local.user@example.com");
  });

  it("never echoes the JWT_SECRET in the response body", async () => {
    const SECRET = "super-secret-do-not-leak";
    process.env.AUTH_PROVIDER = "local";
    process.env.JWT_SECRET = SECRET;

    const res = await request(makeApp())
      .post("/api/auth/local-login")
      .send({ email: "x@y.z" });

    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });
});

// ── /providers ──────────────────────────────────────────────────────────

describe("GET /api/auth/providers", () => {
  it("reports supabase as the default with microsoft disabled in supabase mode", async () => {
    process.env.AUTH_PROVIDER = "supabase";

    const res = await request(makeApp()).get("/api/auth/providers");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      defaultProvider: "supabase",
      providers: [
        { id: "microsoft", name: "Microsoft", mode: "openid", enabled: false },
      ],
    });
  });

  it("reports microsoft as the default with microsoft enabled in entra mode", async () => {
    process.env.AUTH_PROVIDER = "entra";

    const res = await request(makeApp()).get("/api/auth/providers");

    expect(res.body).toEqual({
      defaultProvider: "microsoft",
      providers: [
        { id: "microsoft", name: "Microsoft", mode: "openid", enabled: true },
      ],
    });
  });

  it("reports local as the default in local mode", async () => {
    process.env.AUTH_PROVIDER = "local";

    const res = await request(makeApp()).get("/api/auth/providers");

    expect(res.body.defaultProvider).toBe("local");
    expect(res.body.providers[0].enabled).toBe(false);
  });

  it("requires no Authorization header", async () => {
    process.env.AUTH_PROVIDER = "supabase";

    const res = await request(makeApp()).get("/api/auth/providers");

    expect(res.status).toBe(200);
  });
});

// ── /logout ─────────────────────────────────────────────────────────────

describe("GET /api/auth/logout", () => {
  it("redirects to FRONTEND_URL/login in non-entra modes", async () => {
    process.env.AUTH_PROVIDER = "supabase";

    const res = await request(makeApp()).get("/api/auth/logout");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://app.example.com/login");
  });

  it("redirects through Microsoft's logout endpoint in entra mode", async () => {
    process.env.AUTH_PROVIDER = "entra";
    process.env.ENTRA_TENANT_ID = "tenant-guid";

    const res = await request(makeApp()).get("/api/auth/logout");

    expect(res.status).toBe(302);
    const target = new URL(res.headers.location);
    expect(target.origin).toBe("https://login.microsoftonline.com");
    expect(target.pathname).toBe("/tenant-guid/oauth2/v2.0/logout");
    expect(target.searchParams.get("post_logout_redirect_uri")).toBe(
      "https://app.example.com/login",
    );
  });

  it("defensively redirects to the local login page when entra mode is misconfigured (no tenant id)", async () => {
    process.env.AUTH_PROVIDER = "entra";
    delete process.env.ENTRA_TENANT_ID;

    const res = await request(makeApp()).get("/api/auth/logout");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://app.example.com/login");
  });
});

// ── /select-provider ────────────────────────────────────────────────────

describe("GET /api/auth/select-provider", () => {
  it("returns 404 when AUTH_PROVIDER is not entra", async () => {
    process.env.AUTH_PROVIDER = "supabase";

    const res = await request(makeApp()).get("/api/auth/select-provider");

    expect(res.status).toBe(404);
  });

  it("redirects to /api/auth/login-provider/microsoft with an encoded returnUrl", async () => {
    process.env.AUTH_PROVIDER = "entra";

    const res = await request(makeApp())
      .get("/api/auth/select-provider")
      .query({ returnUrl: "/dashboard" });

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(
      /^\/api\/auth\/login-provider\/microsoft\?returnUrl=/,
    );
  });

  it("forwards selectAccount=true into the downstream URL", async () => {
    process.env.AUTH_PROVIDER = "entra";

    const res = await request(makeApp())
      .get("/api/auth/select-provider")
      .query({ returnUrl: "/x", selectAccount: "true" });

    expect(res.headers.location).toMatch(/&selectAccount=true$/);
  });

  it("omits selectAccount when not explicitly true", async () => {
    process.env.AUTH_PROVIDER = "entra";

    const res = await request(makeApp())
      .get("/api/auth/select-provider")
      .query({ returnUrl: "/x", selectAccount: "false" });

    expect(res.headers.location).not.toMatch(/selectAccount/);
  });
});

// ── /login-provider/:providerId ─────────────────────────────────────────

describe("GET /api/auth/login-provider/:providerId", () => {
  beforeEach(() => {
    process.env.AUTH_PROVIDER = "entra";
    process.env.ENTRA_TENANT_ID = "tenant-guid";
    process.env.ENTRA_CLIENT_ID = "client-guid";
    process.env.ENTRA_BACKEND_CLIENT_ID = "backend-client-guid";
  });

  it("returns 404 for unknown providers", async () => {
    const res = await request(makeApp()).get("/api/auth/login-provider/google");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ detail: "Unknown auth provider 'google'" });
  });

  it("returns 404 when AUTH_PROVIDER is not entra", async () => {
    process.env.AUTH_PROVIDER = "supabase";

    const res = await request(makeApp()).get(
      "/api/auth/login-provider/microsoft",
    );

    expect(res.status).toBe(404);
  });

  it("returns 500 when ENTRA_TENANT_ID is missing", async () => {
    delete process.env.ENTRA_TENANT_ID;

    const res = await request(makeApp()).get(
      "/api/auth/login-provider/microsoft",
    );

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ detail: "Missing Entra OpenID configuration" });
  });

  it("redirects to login.microsoftonline.com with all required OAuth parameters", async () => {
    const res = await request(makeApp())
      .get("/api/auth/login-provider/microsoft")
      .query({ returnUrl: "/dashboard" });

    expect(res.status).toBe(302);
    const target = new URL(res.headers.location);
    expect(target.origin).toBe("https://login.microsoftonline.com");
    expect(target.pathname).toBe("/tenant-guid/oauth2/v2.0/authorize");
    expect(target.searchParams.get("client_id")).toBe("client-guid");
    expect(target.searchParams.get("response_type")).toBe("code");
    expect(target.searchParams.get("response_mode")).toBe("query");
    expect(target.searchParams.get("scope")).toBe(
      "openid profile email offline_access api://backend-client-guid/access_as_user",
    );
    expect(target.searchParams.get("state")).toBeTruthy();
    expect(target.searchParams.get("redirect_uri")).toMatch(
      /\/api\/auth\/openid-callback\/microsoft$/,
    );
  });

  it("uses ENTRA_REDIRECT_URI when set instead of the request-derived URL", async () => {
    process.env.ENTRA_REDIRECT_URI = "https://configured.example.com/callback";

    const res = await request(makeApp()).get(
      "/api/auth/login-provider/microsoft",
    );

    const target = new URL(res.headers.location);
    expect(target.searchParams.get("redirect_uri")).toBe(
      "https://configured.example.com/callback",
    );
  });

  it("uses ENTRA_AUTH_SCOPES when set instead of the api://<backend>/access_as_user default", async () => {
    process.env.ENTRA_AUTH_SCOPES = "openid profile email custom-scope";

    const res = await request(makeApp()).get(
      "/api/auth/login-provider/microsoft",
    );

    const target = new URL(res.headers.location);
    expect(target.searchParams.get("scope")).toBe(
      "openid profile email custom-scope",
    );
  });

  it("adds prompt=select_account only when selectAccount=true", async () => {
    const withFlag = await request(makeApp())
      .get("/api/auth/login-provider/microsoft")
      .query({ selectAccount: "true" });
    expect(new URL(withFlag.headers.location).searchParams.get("prompt"))
      .toBe("select_account");

    const without = await request(makeApp()).get(
      "/api/auth/login-provider/microsoft",
    );
    expect(new URL(without.headers.location).searchParams.has("prompt"))
      .toBe(false);
  });

  it("throws (returns 500) when NODE_ENV=production and no AUTH_STATE_SECRET / JWT_SECRET / ENTRA_CLIENT_SECRET is set", async () => {
    delete process.env.AUTH_STATE_SECRET;
    delete process.env.JWT_SECRET;
    delete process.env.ENTRA_CLIENT_SECRET;
    process.env.NODE_ENV = "production";
    // Suppress the express-default-error stack trace from polluting test output.
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(makeApp()).get(
      "/api/auth/login-provider/microsoft",
    );

    expect(res.status).toBe(500);
  });

  it("rejects a returnUrl whose origin differs from FRONTEND_URL — open-redirect guard", async () => {
    const res = await request(makeApp())
      .get("/api/auth/login-provider/microsoft")
      .query({ returnUrl: "https://attacker.example.org/phish" });

    const target = new URL(res.headers.location);
    const state = target.searchParams.get("state") ?? "";
    const [payloadB64] = state.split(".");
    const padded = payloadB64 + "=".repeat((4 - (payloadB64.length % 4)) % 4);
    const payload = JSON.parse(
      Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as { returnUrl: string };
    // Must have been replaced with the in-origin fallback.
    expect(new URL(payload.returnUrl).origin).toBe("https://app.example.com");
  });

  it("signs the state with HMAC-SHA256 over the payload — verifies against AUTH_STATE_SECRET", async () => {
    process.env.AUTH_STATE_SECRET = "state-signing-secret";

    const res = await request(makeApp()).get(
      "/api/auth/login-provider/microsoft",
    );

    const state = new URL(res.headers.location).searchParams.get("state") ?? "";
    const [payload, sig] = state.split(".");
    const expected = createHmac("sha256", "state-signing-secret")
      .update(payload)
      .digest("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    expect(sig).toBe(expected);
  });
});

// ── /openid-callback/:providerId ────────────────────────────────────────

describe("GET /api/auth/openid-callback/:providerId", () => {
  beforeEach(() => {
    process.env.AUTH_PROVIDER = "entra";
    process.env.ENTRA_TENANT_ID = "tenant-guid";
    process.env.ENTRA_CLIENT_ID = "client-guid";
    process.env.ENTRA_BACKEND_CLIENT_ID = "backend-client-guid";
    process.env.AUTH_STATE_SECRET = "state-signing-secret";
  });

  function makeState(returnUrl: string, createdAt = Date.now()): string {
    const payload = Buffer.from(
      JSON.stringify({ returnUrl, createdAt }),
    )
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const sig = createHmac("sha256", "state-signing-secret")
      .update(payload)
      .digest("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    return `${payload}.${sig}`;
  }

  it("returns 404 for unknown providers", async () => {
    const res = await request(makeApp()).get(
      "/api/auth/openid-callback/google",
    );

    expect(res.status).toBe(404);
  });

  it("returns 400 when the IdP sent an error query parameter", async () => {
    const res = await request(makeApp())
      .get("/api/auth/openid-callback/microsoft")
      .query({ error: "access_denied", error_description: "user cancelled" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ detail: "user cancelled" });
  });

  it("returns 400 when the code parameter is missing", async () => {
    const res = await request(makeApp())
      .get("/api/auth/openid-callback/microsoft")
      .query({ state: makeState("https://app.example.com/x") });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ detail: "Invalid OpenID callback" });
  });

  it("returns 400 when the state has a tampered signature", async () => {
    const goodState = makeState("https://app.example.com/x");
    const [payload] = goodState.split(".");
    const tampered = `${payload}.AAAAtamperedAAAA`;

    const res = await request(makeApp())
      .get("/api/auth/openid-callback/microsoft")
      .query({ code: "auth-code", state: tampered });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ detail: "Invalid OpenID callback" });
  });

  it("returns 400 when the state is older than 10 minutes (replay window)", async () => {
    const stale = makeState(
      "https://app.example.com/x",
      Date.now() - 11 * 60 * 1000,
    );

    const res = await request(makeApp())
      .get("/api/auth/openid-callback/microsoft")
      .query({ code: "auth-code", state: stale });

    expect(res.status).toBe(400);
  });

  it("returns 400 when the state payload lacks required fields", async () => {
    const payloadB64 = Buffer.from(JSON.stringify({ foo: "bar" }))
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const sig = createHmac("sha256", "state-signing-secret")
      .update(payloadB64)
      .digest("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

    const res = await request(makeApp())
      .get("/api/auth/openid-callback/microsoft")
      .query({ code: "c", state: `${payloadB64}.${sig}` });

    expect(res.status).toBe(400);
  });

  it("exchanges the code, then redirects to the returnUrl with the access token in the fragment", async () => {
    process.env.ENTRA_CLIENT_SECRET = "client-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "the-access-token",
              token_type: "Bearer",
              expires_in: 3600,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );

    const state = makeState("https://app.example.com/dashboard");
    const res = await request(makeApp())
      .get("/api/auth/openid-callback/microsoft")
      .query({ code: "auth-code", state });

    expect(res.status).toBe(302);
    const target = new URL(res.headers.location);
    expect(target.origin).toBe("https://app.example.com");
    expect(target.pathname).toBe("/dashboard");
    const fragment = new URLSearchParams(target.hash.slice(1));
    expect(fragment.get("access_token")).toBe("the-access-token");
    expect(fragment.get("token_type")).toBe("Bearer");
    expect(fragment.get("expires_in")).toBe("3600");
  });

  it("posts client_id, grant_type, code, redirect_uri, and scope to the token endpoint", async () => {
    process.env.ENTRA_CLIENT_SECRET = "the-client-secret";
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ access_token: "tok", token_type: "Bearer" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchFn);

    const state = makeState("https://app.example.com/x");
    await request(makeApp())
      .get("/api/auth/openid-callback/microsoft")
      .query({ code: "the-code", state });

    expect(fetchFn).toHaveBeenCalledWith(
      "https://login.microsoftonline.com/tenant-guid/oauth2/v2.0/token",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: expect.any(URLSearchParams),
      }),
    );
    const body = (fetchFn.mock.calls[0]?.[1] as { body: URLSearchParams }).body;
    expect(body.get("client_id")).toBe("client-guid");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("client_secret")).toBe("the-client-secret");
  });

  it("redirects to /login?error=... when the token exchange fails (does NOT 5xx the user)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: "invalid_grant",
              error_description: "The provided code is expired",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );

    const state = makeState("https://app.example.com/x");
    const res = await request(makeApp())
      .get("/api/auth/openid-callback/microsoft")
      .query({ code: "c", state });

    expect(res.status).toBe(302);
    const target = new URL(res.headers.location);
    expect(target.origin).toBe("https://app.example.com");
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("error")).toBe(
      "The provided code is expired",
    );
  });

  it("redirects to /login?error=... when entra config is incomplete at exchange time", async () => {
    // State was signed earlier; now wipe the tenant id so exchangeEntraCode
    // sees missing config. The route must not 5xx — it should redirect the
    // user to /login with the explanatory error.
    const state = makeState("https://app.example.com/x");
    delete process.env.ENTRA_TENANT_ID;

    const res = await request(makeApp())
      .get("/api/auth/openid-callback/microsoft")
      .query({ code: "c", state });

    expect(res.status).toBe(302);
    const target = new URL(res.headers.location);
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("error")).toBe(
      "Missing Entra OpenID configuration",
    );
  });

  it("redirects to /login?error=... when the response has no access_token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ token_type: "Bearer" }), {
            status: 200,
          }),
        ),
      ),
    );

    const state = makeState("https://app.example.com/x");
    const res = await request(makeApp())
      .get("/api/auth/openid-callback/microsoft")
      .query({ code: "c", state });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/login?error=");
  });
});
