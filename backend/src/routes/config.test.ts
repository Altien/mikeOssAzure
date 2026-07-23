import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import request from "supertest";
import { makeApp } from "../test/helpers/buildTestApp";

const TOUCHED_ENV = [
  "AUTH_PROVIDER",
  "DEMO_MODE",
  "ENTRA_TENANT_ID",
  "ENTRA_CLIENT_ID",
  "ENTRA_FRONTEND_CLIENT_ID",
  "FRONTEND_URL",
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
});

describe("GET /config — wiring", () => {
  it("requires no Authorization header (unauthenticated by design)", async () => {
    const res = await request(makeApp()).get("/config");

    expect(res.status).toBe(200);
  });

  it("sets a short Cache-Control so /install's invalidation can take effect", async () => {
    const res = await request(makeApp()).get("/config");

    expect(res.headers["cache-control"]).toBe("public, max-age=60");
  });

  it("responds with JSON content-type", async () => {
    const res = await request(makeApp()).get("/config");

    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });
});

describe("GET /config — authProvider field", () => {
  it("defaults to 'supabase' when AUTH_PROVIDER is unset", async () => {
    const res = await request(makeApp()).get("/config");

    expect(res.body.authProvider).toBe("supabase");
  });

  it("returns 'entra' when AUTH_PROVIDER=entra", async () => {
    process.env.AUTH_PROVIDER = "entra";

    const res = await request(makeApp()).get("/config");

    expect(res.body.authProvider).toBe("entra");
  });

  it("returns 'local' when AUTH_PROVIDER=local", async () => {
    process.env.AUTH_PROVIDER = "local";

    const res = await request(makeApp()).get("/config");

    expect(res.body.authProvider).toBe("local");
  });

  it("clamps any unknown AUTH_PROVIDER value to 'supabase' (allow-list, never echo arbitrary input)", async () => {
    process.env.AUTH_PROVIDER = "evil-injection-value";

    const res = await request(makeApp()).get("/config");

    expect(res.body.authProvider).toBe("supabase");
  });

  it("normalises case (ENTRA, EnTrA all map to entra)", async () => {
    process.env.AUTH_PROVIDER = "ENTRA";

    const res = await request(makeApp()).get("/config");

    expect(res.body.authProvider).toBe("entra");
  });
});

describe("GET /config — demoMode field", () => {
  it("defaults to false when DEMO_MODE is unset", async () => {
    const res = await request(makeApp()).get("/config");

    expect(res.body.demoMode).toBe(false);
  });

  it("returns true only when DEMO_MODE=true", async () => {
    process.env.DEMO_MODE = "true";
    expect((await request(makeApp()).get("/config")).body.demoMode).toBe(true);

    process.env.DEMO_MODE = "TRUE";
    expect((await request(makeApp()).get("/config")).body.demoMode).toBe(false);
  });
});

describe("GET /config — entra block", () => {
  it("surfaces ENTRA_TENANT_ID and ENTRA_CLIENT_ID when both are set", async () => {
    process.env.AUTH_PROVIDER = "entra";
    process.env.ENTRA_TENANT_ID = "tenant-guid";
    process.env.ENTRA_CLIENT_ID = "client-guid";

    const res = await request(makeApp()).get("/config");

    expect(res.body.entra).toEqual({
      tenantId: "tenant-guid",
      clientId: "client-guid",
    });
  });

  it("falls back to ENTRA_FRONTEND_CLIENT_ID when ENTRA_CLIENT_ID is unset", async () => {
    process.env.ENTRA_FRONTEND_CLIENT_ID = "frontend-client-guid";

    const res = await request(makeApp()).get("/config");

    expect(res.body.entra.clientId).toBe("frontend-client-guid");
  });

  it("returns empty strings (never undefined) when no entra env is configured — keeps the JSON shape stable", async () => {
    const res = await request(makeApp()).get("/config");

    expect(res.body.entra).toEqual({ tenantId: "", clientId: "" });
  });
});

describe("GET /config — secret-leak guard", () => {
  it("does NOT expose any of the server-only secrets — the body contains only documented public runtime config", async () => {
    process.env.AUTH_PROVIDER = "entra";
    process.env.ENTRA_TENANT_ID = "tenant-guid";
    process.env.ENTRA_CLIENT_ID = "client-guid";
    // Set every secret that should NOT leak through this endpoint.
    process.env.JWT_SECRET = "JWT_SECRET_VALUE_DO_NOT_LEAK";
    process.env.AUTH_STATE_SECRET = "AUTH_STATE_SECRET_VALUE_DO_NOT_LEAK";
    process.env.ENTRA_CLIENT_SECRET = "ENTRA_CLIENT_SECRET_VALUE_DO_NOT_LEAK";
    process.env.SUPABASE_SECRET_KEY = "SUPABASE_KEY_VALUE_DO_NOT_LEAK";
    process.env.DOWNLOAD_SIGNING_SECRET = "DOWNLOAD_SECRET_VALUE_DO_NOT_LEAK";
    process.env.USER_API_KEYS_ENCRYPTION_KEY = "ENCKEY_VALUE_DO_NOT_LEAK";

    const res = await request(makeApp()).get("/config");

    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain("DO_NOT_LEAK");
    // Extra defensive: only the documented keys must be present.
    expect(Object.keys(res.body).sort()).toEqual([
      "authProvider",
      "demoMode",
      "entra",
    ]);
    expect(Object.keys(res.body.entra).sort()).toEqual([
      "clientId",
      "tenantId",
    ]);
  });

  it("does not leak the FRONTEND_URL or any backend env that happens to be set", async () => {
    process.env.AUTH_PROVIDER = "entra";
    process.env.ENTRA_TENANT_ID = "tenant-guid";
    process.env.FRONTEND_URL = "https://app.example.com";
    process.env.PORT = "9999";
    process.env.KEY_VAULT_NAME = "sensitive-kv-name";

    const res = await request(makeApp()).get("/config");

    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain("https://app.example.com");
    expect(bodyStr).not.toContain("9999");
    expect(bodyStr).not.toContain("sensitive-kv-name");
  });
});
