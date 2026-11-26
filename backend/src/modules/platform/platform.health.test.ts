// The health page's checks: isolation, Entra outcome mapping, and above all that
// no secret, token, connection string or row reaches the output. The last suite
// runs the real route, real signing client and real Entra code against fake
// Entra, Graph, PostgREST and PostgreSQL that answer with sentinels.

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  graphToken: vi.fn(),
  pgConnect: vi.fn(async () => {}),
  pgQuery: vi.fn(async (_sql: string, _params?: unknown[]): Promise<{ rows: unknown[] }> => ({ rows: [] })),
  listFiles: vi.fn(async (_prefix: string): Promise<string[]> => []),
  sentryEnabled: vi.fn(() => false),
  kvGet: vi.fn(),
  pgEnd: vi.fn(),
  scrub: { throws: false },
}));

vi.mock("pg", () => {
  class FakeClient {
    connect() { return mocks.pgConnect(); }
    query(sql: string, params?: unknown[]) { return mocks.pgQuery(sql, params); }
    on() { return this; }
    async end() { mocks.pgEnd(); }
  }
  return { Client: FakeClient, default: { Client: FakeClient } };
});
vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class { getToken() { return mocks.graphToken(); } },
}));
vi.mock("@azure/keyvault-secrets", () => ({
  SecretClient: class { getSecret(name: string) { return mocks.kvGet(name); } },
}));
vi.mock("../../lib/storage", () => ({ storageEnabled: true, listFiles: mocks.listFiles }));
// The only way a run can reject: every check is isolated, but the output scrub is not.
vi.mock("../../lib/safeError", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/safeError")>();
  return {
    ...actual,
    redactSensitiveText: (text: string) => {
      if (mocks.scrub.throws) throw new Error("scrub failed");
      return actual.redactSensitiveText(text);
    },
  };
});
vi.mock("../../lib/observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/observability/sentry")>()),
  isSentryEnabled: mocks.sentryEnabled,
}));

import { flushConfigCache } from "../../lib/config";
import { shippedMigrations } from "../../lib/schemaCheck";
import { resetPostgrestJwtState } from "../../lib/supabase";
import { resetFrozenTenancyModeForTests } from "../../lib/tenancyMode";
import { resetTenantConfigCache } from "../../lib/tenantContext";
import { createDiagRouter } from "./diagnostics.routes";
import { resetHealthRunForTests, runChecks, runHealthChecks } from "./platform.health";
import { databaseChecks, withReadOnlySession } from "./platform.healthDatabase";
import { assessCredentials, mapEntraTokenError } from "./platform.healthEntra";
import type { HealthResult } from "./platform.shared";

const SECRET_NAME = "entra-client-secret";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-06T00:00:00Z");

const SENTINELS = {
  clientSecret: "SENTINELclientSecretValue",
  jwt: "SENTINEL-postgrest-jwt-secret-of-at-least-32-characters",
  entraToken: "SENTINEL.entra.access.token",
  graphToken: "SENTINEL.graph.access.token",
  dbPassword: "SENTINELdbpassword",
  rowContent: "SENTINEL-row-content",
  entraDescription: "SENTINEL-entra-description",
  dbMessage: "SENTINEL-database-message",
  diagnosticsToken: "SENTINEL-diagnostics-token",
  provider: "SENTINEL-provider-key",
  session: "SENTINEL-session-encryption",
};
const CONNECTION = `postgres://mike:${SENTINELS.dbPassword}@db.internal.example.test:5432/mike`;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function byId(results: HealthResult[], id: string): HealthResult {
  const found = results.find((result) => result.id === id);
  if (!found) throw new Error(`no result ${id}`);
  return found;
}

describe("runChecks", () => {
  const passing = { id: "ok", group: "G", title: "Ok", run: async () => ({ status: "pass" as const, detail: "Fine." }) };

  it("isolates a throwing check, and keeps only its code", async () => {
    const results = await runChecks([
      {
        id: "boom", group: "G", title: "Boom",
        run: async () => { throw Object.assign(new Error(`raw ${SENTINELS.dbMessage}`), { code: "42P01" }); },
      },
      passing,
    ]);
    expect(byId(results, "ok").status).toBe("pass");
    expect(byId(results, "boom")).toMatchObject({ status: "fail", detail: "The check could not complete (code 42P01)." });
    expect(byId(results, "boom").remediation).toBeTruthy();
    expect(JSON.stringify(results)).not.toContain(SENTINELS.dbMessage);
  });

  it("isolates a check that throws synchronously", async () => {
    const results = await runChecks([
      { id: "sync", group: "G", title: "Sync", run: () => { throw new Error("no"); } },
      passing,
    ]);
    expect(byId(results, "sync").status).toBe("fail");
    expect(byId(results, "ok").status).toBe("pass");
  });

  it("times out a hanging check, aborts it, and still returns the rest", async () => {
    let aborted = false;
    const results = await runChecks([
      {
        id: "hang", group: "G", title: "Hang",
        run: (signal) => new Promise(() => { signal.addEventListener("abort", () => { aborted = true; }); }),
      },
      passing,
    ], 20);
    expect(byId(results, "hang").status).toBe("fail");
    expect(byId(results, "hang").detail).toContain("Did not finish");
    expect(byId(results, "hang").remediation).toBeTruthy();
    expect(byId(results, "ok").status).toBe("pass");
    expect(aborted).toBe(true);
  });

  it("runs checks concurrently", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const results = await runChecks([
      { id: "waits", group: "G", title: "Waits", run: async () => { await gate; return { status: "pass", detail: "x" }; } },
      { id: "frees", group: "G", title: "Frees", run: async () => { release(); return { status: "pass", detail: "y" }; } },
    ], 1000);
    expect(results.map((result) => result.status)).toEqual(["pass", "pass"]);
  });

  it("gives a warn or fail without its own remediation a default one, and scrubs output", async () => {
    const results = await runChecks([{
      id: "leaky", group: "G", title: "Leaky",
      run: async () => ({ status: "warn", detail: `line one\nurl ${CONNECTION} token=${SENTINELS.entraToken}` }),
    }]);
    expect(results[0].remediation).toBeTruthy();
    expect(results[0].detail).not.toContain("\n");
    expect(results[0].detail).not.toContain(SENTINELS.dbPassword);
    expect(results[0].detail).not.toContain(SENTINELS.entraToken);
  });
});

describe("mapEntraTokenError", () => {
  it("names an expired secret and says how to replace it", () => {
    const outcome = mapEntraTokenError({ error_codes: [7000222] }, 401, SECRET_NAME);
    expect(outcome.status).toBe("fail");
    expect(outcome.detail).toContain("expired");
    expect(outcome.detail).toContain("AADSTS7000222");
    expect(outcome.remediation).toContain("new version of Key Vault entra-client-secret");
    expect(outcome.remediation).toContain("Do not re-run create-entra-apps.ps1");
  });

  it("asks for a new revision only when the env reference is what wins", () => {
    vi.stubEnv("ENTRA_CLIENT_SECRET", "a-value-from-a-hand-added-reference");
    const fromEnv = mapEntraTokenError({ error_codes: [7000222] }, 401, SECRET_NAME).remediation;
    expect(fromEnv).toContain("new backend revision");
    expect(fromEnv).toContain("env reference ENTRA_CLIENT_SECRET wins");
    expect(fromEnv).not.toContain("5 minutes");

    for (const notSet of ["", "__unset__"]) {
      vi.stubEnv("ENTRA_CLIENT_SECRET", notSet);
      const fromVault = mapEntraTokenError({ error_codes: [7000222] }, 401, SECRET_NAME).remediation;
      expect(fromVault).toContain("within about 5 minutes");
      expect(fromVault).toContain("no new revision");
      expect(fromVault).not.toContain("env reference");
    }
    vi.unstubAllEnvs();
  });

  it.each([
    [7000215, "fail", "invalid"],
    [700016, "fail", "cannot find"],
  ])("maps AADSTS%i to %s", (code, status, text) => {
    const outcome = mapEntraTokenError({ error_codes: [code] }, 400, SECRET_NAME);
    expect(outcome.status).toBe(status);
    expect(outcome.detail).toContain(text);
    expect(outcome.detail).toContain(`AADSTS${code}`);
    expect(outcome.remediation).toBeTruthy();
  });

  it("shows only the code for any other error", () => {
    const outcome = mapEntraTokenError(
      { error_codes: [53003], error_description: `AADSTS53003: ${SENTINELS.entraDescription}` }, 400, SECRET_NAME,
    );
    expect(outcome.status).toBe("warn");
    expect(outcome.detail).toContain("AADSTS53003");
    expect(JSON.stringify(outcome)).not.toContain(SENTINELS.entraDescription);
  });

  it("names the settings a pooled stamp uses for AADSTS700016", () => {
    const pooled = mapEntraTokenError({ error_codes: [700016] }, 400, "altien-entra-client-secret").remediation;
    expect(pooled).toContain("altien-entra-client-id, altien-entra-tenant-id, altien-entra-authority");
    expect(pooled).not.toMatch(/(^|\s)entra-client-id/);
    const single = mapEntraTokenError({ error_codes: [700016] }, 400, SECRET_NAME).remediation;
    expect(single).toContain("entra-client-id, entra-tenant-id");
    expect(single).not.toContain("altien");
  });

  it("asks for a new revision for AADSTS700016 only when an env reference wins", () => {
    vi.stubEnv("ENTRA_CLIENT_ID", "");
    vi.stubEnv("ENTRA_TENANT_ID", "__unset__");
    const fromVault = mapEntraTokenError({ error_codes: [700016] }, 400, SECRET_NAME).remediation;
    expect(fromVault).toContain("they take effect within about 5 minutes");
    expect(fromVault).not.toContain("create a new backend revision");

    vi.stubEnv("ENTRA_CLIENT_ID", "client-from-a-hand-added-reference");
    const fromEnv = mapEntraTokenError({ error_codes: [700016] }, 400, SECRET_NAME).remediation;
    expect(fromEnv).toContain("create a new backend revision");
    expect(fromEnv).toContain("env reference ENTRA_CLIENT_ID wins");
    expect(fromEnv).not.toContain("5 minutes");
    vi.unstubAllEnvs();
  });

  it("reads the code from the description when error_codes is absent", () => {
    const outcome = mapEntraTokenError({ error_description: `AADSTS7000222: ${SENTINELS.entraDescription}` }, 401, SECRET_NAME);
    expect(outcome.status).toBe("fail");
    expect(JSON.stringify(outcome)).not.toContain(SENTINELS.entraDescription);
  });

  it("copes with no code at all", () => {
    expect(mapEntraTokenError(null, 503, SECRET_NAME).detail).toContain("HTTP 503");
  });
});

describe("assessCredentials", () => {
  const secret = "abcSecretValue";
  const inDays = (days: number) => new Date(NOW + days * DAY).toISOString();

  it("passes with the date when the matching credential is far from expiry", () => {
    const outcome = assessCredentials(secret, [
      { hint: "abc", endDateTime: inDays(200), displayName: "current" },
      { hint: "xyz", endDateTime: inDays(10 - 400), displayName: "long expired" },
    ], SECRET_NAME, NOW);
    expect(outcome.status).toBe("pass");
    expect(outcome.detail).toContain(inDays(200).slice(0, 10));
    expect(outcome.detail).not.toContain("long expired");
  });

  it("fails when the matching credential has expired, with the replacement steps", () => {
    const outcome = assessCredentials(secret, [{ hint: "abc", endDateTime: inDays(-1) }], SECRET_NAME, NOW);
    expect(outcome.status).toBe("fail");
    expect(outcome.remediation).toContain("Create a new client secret");
  });

  it("warns within 30 days", () => {
    expect(assessCredentials(secret, [{ hint: "abc", endDateTime: inDays(29) }], SECRET_NAME, NOW).status).toBe("warn");
    expect(assessCredentials(secret, [{ hint: "abc", endDateTime: inDays(31) }], SECRET_NAME, NOW).status).toBe("pass");
  });

  it("is unknown, not a failure, when nothing matches", () => {
    const outcome = assessCredentials(secret, [{ hint: "xyz", endDateTime: inDays(-1) }], SECRET_NAME, NOW);
    expect(outcome.status).toBe("info");
    expect(outcome.detail).toContain("unknown");
  });

  it("is unknown when the hint is ambiguous, rather than guessing", () => {
    const outcome = assessCredentials(secret, [
      { hint: "abc", endDateTime: inDays(-1) }, { hint: "abc", endDateTime: inDays(100) },
    ], SECRET_NAME, NOW);
    expect(outcome.status).toBe("info");
  });

  it("warns about another credential expiring soon, by display name", () => {
    const outcome = assessCredentials(secret, [
      { hint: "abc", endDateTime: inDays(100) },
      { hint: "xyz", endDateTime: inDays(5), displayName: "old-deploy" },
    ], SECRET_NAME, NOW);
    expect(outcome.status).toBe("warn");
    expect(outcome.detail).toContain("old-deploy");
    expect(outcome.remediation).toBeTruthy();
  });

  it("keeps a failure as a failure when another credential is also expiring", () => {
    const outcome = assessCredentials(secret, [
      { hint: "abc", endDateTime: inDays(-1) },
      { hint: "xyz", endDateTime: inDays(5), displayName: "old-deploy" },
    ], SECRET_NAME, NOW);
    expect(outcome.status).toBe("fail");
    expect(outcome.remediation).toContain("Create a new client secret");
  });

  it("never outputs the secret or the hint", () => {
    const outcome = assessCredentials(secret, [{ hint: "abc", endDateTime: inDays(100), displayName: "named" }], SECRET_NAME, NOW);
    expect(JSON.stringify(outcome)).not.toContain("abc");
  });
});

describe("the whole page, against fake services", () => {
  type Scenario = {
    entra: () => Response;
    graph: () => Response;
    postgrest: (url: URL, role: string | undefined, tenantId: string | undefined) => Response;
  };
  const SHIPPED = shippedMigrations();
  /** What the fake direct session answers. Each test overrides only what it is about. */
  const healthySession = (overrides: { applied?: string[]; bypass?: { rolbypassrls: boolean }[] } = {}) =>
    async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes("pgmigrations")) return { rows: (overrides.applied ?? SHIPPED).map((name) => ({ name })) };
      if (sql.includes("tenant_rls_gaps")) return { rows: [{ gaps: 0 }] };
      if (sql.includes("pg_roles")) return { rows: overrides.bypass ?? [{ rolbypassrls: true }] };
      return { rows: [] };
    };
  const failing = (message: string, code?: string) => Object.assign(new Error(`${message} ${CONNECTION}`), { code });
  const expectNoRoleAdvice = (result: HealthResult) => {
    expect(result.remediation).toBeTruthy();
    expect(result.remediation).not.toContain("GRANT");
    expect(result.remediation).not.toContain("tenant-rls-enforced");
    expect(result.detail).not.toContain("could not use role");
  };
  let scenario: Scenario;
  let outbound: string[];

  const claimsOf = (authorization: string | null): Record<string, unknown> => {
    // Hosted Supabase's key is not a JWT. A throw here would look like a network failure and be retried.
    const payload = authorization?.split(".")[1];
    if (!payload) return {};
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  };

  /** postgrest-js waits 1, 2 and 4 s before retrying a 503. Only that clock is faked. */
  const withoutRetryDelays = async <T>(run: () => Promise<T>): Promise<T> => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let settled = false;
      const pending = run().finally(() => { settled = true; });
      while (!settled) await vi.advanceTimersByTimeAsync(1_000);
      return await pending;
    } finally {
      vi.useRealTimers();
    }
  };

  const healthyPostgrest: Scenario["postgrest"] = (url, role) => {
    if (url.pathname === "/rpc/stamp_runtime_metadata") {
      return json(200, { pooled: false, fallback_tenant_id: "tenant-under-test", stamp_id: null, region: null, platform_credentials: [] });
    }
    if (!role) return json(401, { code: "PGRST302", message: SENTINELS.dbMessage });
    if (url.pathname === "/tenants" && url.searchParams.get("select") === "status") {
      return json(200, [{ status: "active" }]);
    }
    if (url.pathname === "/db_jobs" && url.searchParams.get("select") !== "id") {
      return json(200, []);
    }
    // Data assignment: nothing is held under another tenant.
    if (url.searchParams.get("tenant_id")?.startsWith("neq.")) return json(200, [], { "content-range": "*/0" });
    return json(200, [{ tenant_id: SENTINELS.rowContent }], { "content-range": "0-0/1" });
  };

  beforeEach(() => {
    outbound = [];
    scenario = {
      entra: () => json(200, { access_token: SENTINELS.entraToken, expires_in: 3599 }),
      graph: () => json(200, {
        passwordCredentials: [{ hint: SENTINELS.clientSecret.slice(0, 3), endDateTime: "2099-01-01T00:00:00Z", displayName: "current" }],
        web: {
          redirectUris: [
            "https://backend.example.test/api/auth/openid-callback/microsoft",
            "https://backend.example.test/install/auth/microsoft/callback",
          ],
        },
        spa: { redirectUris: ["https://backend.example.test/login"] },
      }),
      postgrest: healthyPostgrest,
    };
    Object.entries({
      AUTH_PROVIDER: "entra",
      NODE_ENV: "test",
      KEY_VAULT_NAME: "",
      TENANCY_MODE: "",
      TENANT_RLS_ENFORCED: "",
      TENANT_CONTEXT_STRICT: "",
      SUPABASE_URL: "http://postgrest.test",
      POSTGREST_JWT_SECRET: SENTINELS.jwt,
      ENTRA_TENANT_ID: "tenant-under-test",
      ENTRA_CLIENT_ID: "client-under-test",
      ENTRA_CLIENT_SECRET: SENTINELS.clientSecret,
      ENTRA_BACKEND_CLIENT_ID: "backend-under-test",
      BACKEND_PUBLIC_URL: "https://backend.example.test",
      API_PUBLIC_URL: "",
      AUTH_SESSION_ENCRYPTION_SECRET: SENTINELS.session,
      AUTH_HANDOFF_ENCRYPTION_SECRET: SENTINELS.session,
      AUTH_STATE_SECRET: SENTINELS.session,
      STREAM_RUN_DATABASE_URL: CONNECTION,
      APPLICATIONINSIGHTS_CONNECTION_STRING: `InstrumentationKey=${SENTINELS.provider}`,
      ANTHROPIC_API_KEY: `sk-ant-${SENTINELS.provider}`,
      // Every other credential the "AI providers" section reads, so a real one on this machine cannot count.
      OPENAI_API_KEY: "",
      MOONSHOT_API_KEY: "",
      MISTRAL_API_KEY: "",
      GEMINI_API_KEY: "",
      OPENROUTER_API_KEY: "",
      OPENCODE_API_KEY: "",
      TOKENJUICE_API_KEY: "",
      META_API_KEY: "",
      COURTLISTENER_API_TOKEN: "",
      DIAGNOSTICS_HEALTH_TOKEN: SENTINELS.diagnosticsToken,
    }).forEach(([name, value]) => vi.stubEnv(name, value));
    mocks.pgEnd.mockReset();
    mocks.kvGet.mockReset().mockRejectedValue(Object.assign(new Error("Missing"), { statusCode: 404 }));
    mocks.graphToken.mockReset().mockResolvedValue({ token: SENTINELS.graphToken });
    mocks.pgConnect.mockReset().mockResolvedValue(undefined);
    mocks.pgQuery.mockReset().mockImplementation(healthySession());
    mocks.listFiles.mockReset().mockResolvedValue([]);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      outbound.push(`${req.method} ${url.host}${url.pathname}`);
      if (url.host === "login.microsoftonline.com" || url.host === "external.example.test") return scenario.entra();
      if (url.host === "graph.microsoft.com") return scenario.graph();
      const claims = claimsOf(req.headers.get("authorization"));
      return scenario.postgrest(url, claims.role as string | undefined, claims.tenant_id as string | undefined);
    }));
    flushConfigCache();
    resetFrozenTenancyModeForTests();
    resetPostgrestJwtState();
    resetTenantConfigCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    mocks.scrub.throws = false;
    resetHealthRunForTests();
    resetPostgrestJwtState();
    resetTenantConfigCache();
  });

  const page = (format = "") => {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use("/diag", createDiagRouter());
    return request(app).post("/diag").type("form").send(`passphrase=${SENTINELS.diagnosticsToken}${format}`);
  };

  function expectNoSentinel(text: string): void {
    for (const [name, value] of Object.entries(SENTINELS)) {
      expect(text.includes(value), `${name} appeared in the output`).toBe(false);
    }
    expect(text).not.toContain(CONNECTION);
    expect(text).not.toContain("postgres://");
    // The secret's hint: the first three characters are not in any check's words.
    expect(text).not.toContain(SENTINELS.clientSecret.slice(0, 3));
  }

  it("reports a healthy install on every check, and uses no write call", async () => {
    const results = await runHealthChecks({ requestHost: "ignored.example.test" });
    const statuses = Object.fromEntries(results.map((result) => [result.id, result.status]));
    // toEqual, so a check added later has to be listed here.
    expect(statuses).toEqual({
      "config.version": "info",
      "config.auth-provider": "info",
      "config.tenancy-mode": "info",
      "config.tenant-rls": "pass",
      "config.telemetry": "info",
      "config.node-env": "info",
      "config.key-vault": "skip",
      "config.required-secrets": "pass",
      "entra.client-secret": "pass",
      "entra.client-secret-expiry": "pass",
      "entra.redirect-uris": "pass",
      "db.postgrest-signed": "pass",
      "db.unsigned-rejected": "pass",
      "db.tenant-role": "pass",
      "db.service-role-bypass": "pass",
      "db.install-tenant": "pass",
      "db.data-assignment": "pass",
      "db.migrations": "pass",
      "db.rls-gaps": "pass",
      "db.stream-login": "pass",
      "storage.configured": "pass",
      "storage.reachable": "pass",
      "worker.queue": "pass",
      "worker.activity": "info",
      "providers.credentials": "pass",
    });
    expect(JSON.stringify(results)).not.toContain("[redacted]");
    const postgrestCalls = outbound.filter((call) => call.includes("postgrest.test"));
    // The read-only metadata function is the one non-GET, called via POST as every RPC is.
    expect([...new Set(postgrestCalls.filter((call) => !call.startsWith("GET ") && !call.startsWith("HEAD ")))])
      .toEqual(["POST postgrest.test/rpc/stamp_runtime_metadata"]);
    expect(outbound.filter((call) => call.startsWith("POST ") && call.includes("microsoft")))
      .toEqual(["POST login.microsoftonline.com/tenant-under-test/oauth2/v2.0/token"]);
    const sql = mocks.pgQuery.mock.calls.map(([text]) => text.trim().toLowerCase());
    expect(sql.filter((text) => /^(insert|update|delete|alter|create|drop|grant)\b/.test(text))).toEqual([]);
    expect(sql.filter((text) => text === "begin read only").length).toBe(4);
  });

  it("shares one run between concurrent requests, and caches nothing after it", async () => {
    const first = runHealthChecks({ requestHost: "x" });
    const second = runHealthChecks({ requestHost: "x" });
    expect(second).toBe(first);
    await first;
    const opened = mocks.pgConnect.mock.calls.length;
    expect(opened).toBe(4);
    const third = runHealthChecks({ requestHost: "x" });
    expect(third).not.toBe(first);
    await third;
    expect(mocks.pgConnect.mock.calls.length).toBe(opened * 2);
  });

  it("starts a new run after one that rejected", async () => {
    mocks.scrub.throws = true;
    await expect(runHealthChecks({ requestHost: "x" })).rejects.toThrow("scrub failed");
    mocks.scrub.throws = false;
    const results = await runHealthChecks({ requestHost: "x" });
    expect(byId(results, "db.migrations").status).toBe("pass");
  });

  it("does not let an abandoned run clear the run after it", async () => {
    // Each run waits at its storage listing, so the first can end while the second is open.
    const gates: Array<(files: string[]) => void> = [];
    mocks.listFiles.mockImplementation(() => new Promise((resolve) => { gates.push(resolve); }));
    const abandoned = runHealthChecks({ requestHost: "x" });
    resetHealthRunForTests();
    const next = runHealthChecks({ requestHost: "x" });
    expect(next).not.toBe(abandoned);
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[0]([]);
    await abandoned;
    expect(runHealthChecks({ requestHost: "x" })).toBe(next);
    gates[1]([]);
    await next;
  });

  it("closes a live session as soon as its check is aborted", async () => {
    const controller = new AbortController();
    const closes: number[] = [];
    await withReadOnlySession(controller.signal, async () => {
      closes.push(mocks.pgEnd.mock.calls.length);
      controller.abort();
      closes.push(mocks.pgEnd.mock.calls.length);
    });
    expect(closes).toEqual([0, 1]);
  });

  it("does not open a session after the check has timed out", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(withReadOnlySession(controller.signal, async () => 1)).rejects.toThrow("Timed out");
    expect(mocks.pgConnect).not.toHaveBeenCalled();
  });

  it.each([
    [7000222, "Entra says the client secret has expired (AADSTS7000222)."],
    [7000215, "Entra rejected the client secret as invalid (AADSTS7000215)."],
    [700016, "Entra cannot find this app registration in the tenant (AADSTS700016)."],
  ])("keeps the detail for AADSTS%i readable after scrubbing", async (code, detail) => {
    scenario.entra = () => json(400, { error_codes: [code] });
    const secret = byId(await runHealthChecks({ requestHost: "x" }), "entra.client-secret");
    expect(secret).toMatchObject({ status: "fail", detail });
    expect(secret.remediation).not.toContain("[redacted]");
    const body = await page("&format=json");
    expect(byId(body.body.checks, "entra.client-secret").detail).toBe(detail);
    expect((await page()).text).toContain(detail);
  });

  it("says a new Key Vault version is enough when no env reference wins", async () => {
    vi.stubEnv("KEY_VAULT_NAME", "test-vault");
    vi.stubEnv("TENANCY_MODE", "single");
    vi.stubEnv("ENTRA_CLIENT_SECRET", "__unset__");
    mocks.kvGet.mockImplementation(async (name: string) => {
      if (name === "entra-client-secret") return { value: SENTINELS.clientSecret };
      throw Object.assign(new Error("Missing"), { statusCode: 404 });
    });
    scenario.entra = () => json(401, { error_codes: [7000222] });
    const secret = byId(await runHealthChecks({ requestHost: "x" }), "entra.client-secret");
    expect(secret.status).toBe("fail");
    expect(secret.remediation).toContain("within about 5 minutes");
    expect(secret.remediation).not.toContain("env reference");
  });

  it("says when the env reference is what must be replaced", async () => {
    scenario.entra = () => json(401, { error_codes: [7000222] });
    const secret = byId(await runHealthChecks({ requestHost: "x" }), "entra.client-secret");
    expect(secret.remediation).toContain("new backend revision");
    expect(secret.remediation).toContain("env reference ENTRA_CLIENT_SECRET wins");
  });

  describe("a Key Vault outage is not a bad secret", () => {
    const unavailable = () => Object.assign(new Error(SENTINELS.dbMessage), { statusCode: 503 });
    const expectDoNotRotate = (result: HealthResult, name: string) => {
      expect(result.status).toBe("warn");
      expect(result.detail).toContain(`Could not read ${name}`);
      expect(result.detail).toContain("from Key Vault");
      expect(result.detail).not.toContain("has no value");
      expect(result.detail).not.toContain("[redacted]");
      expect(result.remediation).toContain("Do not rotate the client secret");
      expect(result.remediation).toContain("Check Key Vault access and the outage first");
      expect(result.remediation).not.toContain("Create a new client secret");
    };
    beforeEach(() => {
      vi.stubEnv("KEY_VAULT_NAME", "test-vault");
      vi.stubEnv("TENANCY_MODE", "single");
    });

    it("warns, naming every setting, in a full outage", async () => {
      ["ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "ENTRA_BACKEND_CLIENT_ID", "ENTRA_CLIENT_SECRET"].forEach((name) => vi.stubEnv(name, ""));
      mocks.kvGet.mockRejectedValue(unavailable());
      const results = await runHealthChecks({ requestHost: "x" });
      const names = "entra-tenant-id, entra-client-id, entra-backend-client-id, entra-client-secret";
      expectDoNotRotate(byId(results, "entra.client-secret"), names);
      expectDoNotRotate(byId(results, "entra.client-secret-expiry"), names);
      expect(JSON.stringify(results)).not.toContain(SENTINELS.dbMessage);
      expect(outbound.filter((call) => call.includes("/oauth2/v2.0/token"))).toEqual([]);
    });

    it("warns about the secret alone in a partial outage, and sends no token request", async () => {
      vi.stubEnv("ENTRA_CLIENT_SECRET", "");
      mocks.kvGet.mockImplementation(async (name: string) => {
        if (name === "entra-client-secret") throw unavailable();
        throw Object.assign(new Error("Missing"), { statusCode: 404 });
      });
      const results = await runHealthChecks({ requestHost: "x" });
      expectDoNotRotate(byId(results, "entra.client-secret"), "entra-client-secret");
      expectDoNotRotate(byId(results, "entra.client-secret-expiry"), "entra-client-secret");
      expect(outbound.filter((call) => call.includes("/oauth2/v2.0/token"))).toEqual([]);
    });

    it("warns when another setting is unreadable and the secret is fine", async () => {
      vi.stubEnv("ENTRA_BACKEND_CLIENT_ID", "");
      mocks.kvGet.mockRejectedValue(unavailable());
      const results = await runHealthChecks({ requestHost: "x" });
      expectDoNotRotate(byId(results, "entra.client-secret"), "entra-backend-client-id");
    });

    it("warns on a pooled stamp, naming its settings", async () => {
      Object.entries({
        TENANCY_MODE: "pooled",
        ALTIEN_ENTRA_TENANT_ID: "external-directory",
        ALTIEN_ENTRA_AUTHORITY: "https://external.example.test/external-directory",
        ALTIEN_ENTRA_ISSUER: "https://external.example.test/external-directory/v2.0/",
        ALTIEN_ENTRA_JWKS_URI: "https://external.example.test/keys",
        ALTIEN_ENTRA_CLIENT_ID: "external-browser",
        ALTIEN_ENTRA_BACKEND_CLIENT_ID: "external-api",
        ALTIEN_ENTRA_CLIENT_SECRET: "",
      }).forEach(([name, value]) => vi.stubEnv(name, value));
      mocks.kvGet.mockRejectedValue(unavailable());
      const results = await runHealthChecks({ requestHost: "x" });
      expectDoNotRotate(byId(results, "entra.client-secret"), "altien-entra-client-secret");
    });

    it("still says the secret has no value when the vault answers that it does not", async () => {
      vi.stubEnv("ENTRA_CLIENT_SECRET", "");
      const results = await runHealthChecks({ requestHost: "x" });
      const secret = byId(results, "entra.client-secret");
      expect(secret.status).toBe("fail");
      expect(secret.detail).toBe("entra-client-secret has no value.");
      expect(secret.remediation).toContain("Create a new client secret");
      expect(byId(results, "entra.client-secret-expiry").status).toBe("info");
    });

    it("names a setting the vault confirms is absent", async () => {
      vi.stubEnv("ENTRA_CLIENT_ID", "");
      const secret = byId(await runHealthChecks({ requestHost: "x" }), "entra.client-secret");
      expect(secret.status).toBe("fail");
      expect(secret.detail).toContain("incomplete: no value for entra-client-id");
      expect(secret.remediation).toContain("Set entra-client-id in Key Vault");
      expect(secret.remediation).toContain("within about 5 minutes");
    });
  });

  it("says on a pooled stamp that the enterprise secret was not tested", async () => {
    Object.entries({
      TENANCY_MODE: "pooled",
      ALTIEN_ENTRA_TENANT_ID: "external-directory",
      ALTIEN_ENTRA_AUTHORITY: "https://external.example.test/external-directory",
      ALTIEN_ENTRA_ISSUER: "https://external.example.test/external-directory/v2.0/",
      ALTIEN_ENTRA_JWKS_URI: "https://external.example.test/keys",
      ALTIEN_ENTRA_CLIENT_ID: "external-browser",
      ALTIEN_ENTRA_BACKEND_CLIENT_ID: "external-api",
      ALTIEN_ENTRA_CLIENT_SECRET: SENTINELS.clientSecret,
    }).forEach(([name, value]) => vi.stubEnv(name, value));
    const results = await runHealthChecks({ requestHost: "x" });
    const secret = byId(results, "entra.client-secret");
    expect(secret.status).toBe("pass");
    expect(secret.detail).toContain("enterprise entra-client-secret was not tested");
    expect(secret.detail).not.toContain("[redacted]");
    expect(outbound).toContain("POST external.example.test/external-directory/oauth2/v2.0/token");
    expect(outbound.filter((call) => call.startsWith("POST login.microsoftonline.com"))).toEqual([]);
    expect(byId(results, "entra.client-secret-expiry").status).toBe("info");
    expect(byId(results, "db.install-tenant").status).toBe("skip");
    expect(byId(results, "db.data-assignment").status).toBe("skip");
  });

  it("does not mention the enterprise secret on a single install", async () => {
    const secret = byId(await runHealthChecks({ requestHost: "x" }), "entra.client-secret");
    expect(secret.detail).not.toContain("enterprise");
  });

  describe("tenant role", () => {
    it.each([
      [401, "PGRST301", "PGRST_JWT_SECRET"],
      [503, "PGRST002", "running and reachable"],
      [500, "XX000", "running and reachable"],
    ])("gives advice for the cause on HTTP %i %s, with no grant or rollback", async (status, code, advice) => {
      scenario.postgrest = (url, role, tenantId) => {
        if (url.pathname === "/tenants" && role === "tenant_app" && tenantId === "tenant-under-test") {
          return json(status, { code, message: SENTINELS.dbMessage });
        }
        return healthyPostgrest(url, role, tenantId);
      };
      const results = await withoutRetryDelays(() => runHealthChecks({ requestHost: "x" }));
      const result = byId(results, "db.tenant-role");
      expect(result.status).toBe("fail");
      expect(result.detail).toContain(code);
      expect(result.remediation).toContain(advice);
      expectNoRoleAdvice(result);
    });

    it("gives both readings of a 42501 and how to tell them apart, because it only has the code", async () => {
      scenario.postgrest = (url, role, tenantId) => {
        if (url.pathname === "/tenants" && role === "tenant_app") return json(403, { code: "42501", message: "denied" });
        return healthyPostgrest(url, role, tenantId);
      };
      const result = byId(await runHealthChecks({ requestHost: "x" }), "db.tenant-role");
      expect(result.remediation).toContain("cannot tell which");
      expect(result.remediation).toContain("pg_has_role('<login>', 'tenant_app', 'member')");
      expect(result.remediation).toContain("GRANT tenant_app TO <login>");
      expect(result.remediation).toContain("tenant-rls-enforced=false");
      expect(result.remediation).toContain("run the migration job");
    });

    it("gives the same advice for a 22023 as the stream-run check", async () => {
      scenario.postgrest = (url, role, tenantId) => {
        if (url.pathname === "/tenants" && role === "tenant_app") return json(400, { code: "22023", message: "no role" });
        return healthyPostgrest(url, role, tenantId);
      };
      const session = healthySession();
      mocks.pgQuery.mockImplementation(async (sql: string) => {
        if (sql === "set local role tenant_app") throw failing("no role", "22023");
        return session(sql);
      });
      const results = await runHealthChecks({ requestHost: "x" });
      const advice = "Role tenant_app may not exist in this database. Run the migration job.";
      expect(byId(results, "db.tenant-role").remediation).toBe(advice);
      expect(byId(results, "db.stream-login").remediation).toBe(advice);
    });
  });

  describe("stream-run login", () => {
    it.each([
      ["refused", "ECONNREFUSED"],
      ["DNS", "ENOTFOUND"],
      ["bad password", "28P01"],
      ["TLS", "SELF_SIGNED_CERT_IN_CHAIN"],
      ["no code", undefined],
    ])("reports a connection failure as one, not as a role: %s", async (_label, code) => {
      mocks.pgConnect.mockRejectedValue(failing("connect failed", code));
      const result = byId(await runHealthChecks({ requestHost: "x" }), "db.stream-login");
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("Could not connect with the stream-run login");
      expect(result.remediation).toContain("host, login, password and TLS");
      expectNoRoleAdvice(result);
      expect(JSON.stringify(result)).not.toContain(SENTINELS.dbPassword);
    });

    it("reports a Key Vault outage as unreadable configuration", async () => {
      vi.stubEnv("KEY_VAULT_NAME", "test-vault");
      vi.stubEnv("TENANCY_MODE", "single");
      vi.stubEnv("STREAM_RUN_DATABASE_URL", "");
      mocks.kvGet.mockRejectedValue(Object.assign(new Error(SENTINELS.dbMessage), { statusCode: 503 }));
      const result = byId(await runHealthChecks({ requestHost: "x" }), "db.stream-login");
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("Could not read the connection setting");
      expect(result.remediation).toContain("Key Vault");
      expectNoRoleAdvice(result);
    });

    it("reports an invalid connection string as unreadable configuration", async () => {
      vi.stubEnv("STREAM_RUN_DATABASE_URL", "not a uri");
      const result = byId(await runHealthChecks({ requestHost: "x" }), "db.stream-login");
      expect(result.detail).toContain("Could not read the connection setting");
      expectNoRoleAdvice(result);
    });

    it("gives the grant and the rollback when the tenant role is refused", async () => {
      const session = healthySession();
      mocks.pgQuery.mockImplementation(async (sql: string) => {
        if (sql === "set local role tenant_app") throw failing("denied", "42501");
        return session(sql);
      });
      const result = byId(await runHealthChecks({ requestHost: "x" }), "db.stream-login");
      expect(result.detail).toContain("could not use role tenant_app (code 42501)");
      expect(result.remediation).toContain("GRANT tenant_app TO <login>");
      expect(result.remediation).toContain("tenant-rls-enforced=false");
    });

    it("names service_role, with no rollback, when that role is refused", async () => {
      const session = healthySession();
      mocks.pgQuery.mockImplementation(async (sql: string) => {
        if (sql === "set local role service_role") throw failing("denied", "42501");
        return session(sql);
      });
      const result = byId(await runHealthChecks({ requestHost: "x" }), "db.stream-login");
      expect(result.detail).toContain("could not use role service_role");
      expect(result.remediation).toContain("GRANT service_role TO <login>");
      expect(result.remediation).not.toContain("tenant-rls-enforced");
    });

    it("does not blame the login when the table read is refused after the role switch", async () => {
      const session = healthySession();
      mocks.pgQuery.mockImplementation(async (sql: string) => {
        if (sql === "select id from public.stream_runs limit 1") throw failing("denied", "42501");
        return session(sql);
      });
      const result = byId(await runHealthChecks({ requestHost: "x" }), "db.stream-login");
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("Role tenant_app could not read public.stream_runs (code 42501)");
      expect(result.remediation).toContain("Role tenant_app lacks a grant on public.stream_runs");
      expect(result.remediation).toContain("migration job");
      expect(result.remediation).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON public.stream_runs TO tenant_app.");
      expect(result.remediation).not.toContain("TO <login>");
      expect(result.remediation).not.toContain("tenant-rls-enforced");
    });

    it("does not blame the role when the connection drops after connecting", async () => {
      const session = healthySession();
      mocks.pgQuery.mockImplementation(async (sql: string) => {
        if (sql === "set local role tenant_app") throw failing("terminated", "57P01");
        return session(sql);
      });
      const result = byId(await runHealthChecks({ requestHost: "x" }), "db.stream-login");
      expect(result.detail).toContain("connection failed while checking role tenant_app");
      expectNoRoleAdvice(result);
    });
  });

  describe("migrations", () => {
    it("passes with every shipped file applied, naming the latest", async () => {
      const result = byId(await runHealthChecks({ requestHost: "x" }), "db.migrations");
      expect(result.status).toBe("pass");
      expect(result.detail).toContain(SHIPPED.at(-1));
    });

    it("fails with a count when shipped files are not applied", async () => {
      mocks.pgQuery.mockImplementation(healthySession({ applied: SHIPPED.slice(0, -2) }));
      const result = byId(await runHealthChecks({ requestHost: "x" }), "db.migrations");
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("2 not applied");
      expect(result.remediation).toContain("migration job");
    });

    it("warns when the database is ahead of this build", async () => {
      mocks.pgQuery.mockImplementation(healthySession({ applied: [...SHIPPED, "9999_future"] }));
      const result = byId(await runHealthChecks({ requestHost: "x" }), "db.migrations");
      expect(result.status).toBe("warn");
      expect(result.detail).toContain("ahead of this build");
    });

    describe("when the history cannot be read", () => {
      const refuse = (statement: string, code: string) => {
        const session = healthySession();
        mocks.pgQuery.mockImplementation(async (sql: string) => {
          if (sql === statement) throw failing("refused", code);
          return session(sql);
        });
      };
      const check = async () => byId(await runHealthChecks({ requestHost: "x" }), "db.migrations");

      it("asks for service_role when the login does not have it", async () => {
        refuse("set local role service_role", "42501");
        const result = await check();
        expect(result.status).toBe("warn");
        expect(result.detail).toContain("code 42501");
        expect(result.remediation).toContain("GRANT service_role TO <login>");
      });

      it("points at the table, not the login, when the read itself is refused", async () => {
        refuse("select name from public.pgmigrations", "42501");
        const result = await check();
        expect(result.remediation).toContain("service_role lacks a grant on public.pgmigrations");
        expect(result.remediation).toContain("GRANT SELECT ON public.pgmigrations TO service_role.");
        expect(result.remediation).not.toContain("TO <login>");
      });

      it("says there is no history when the table is missing", async () => {
        refuse("select name from public.pgmigrations", "42P01");
        const result = await check();
        expect(result.remediation).toContain("no migration history");
        expect(result.remediation).not.toContain("service_role");
      });

      it("gives connection advice for a connection failure", async () => {
        mocks.pgConnect.mockRejectedValue(failing("down", "ECONNREFUSED"));
        const result = await check();
        expect(result.status).toBe("warn");
        expect(result.remediation).toContain("running and reachable");
        expect(result.remediation).not.toContain("service_role");
      });
    });

    it("reads the history as service_role, in the read-only transaction", async () => {
      // This check alone: on the whole page the checks' queries interleave.
      const check = databaseChecks().find((candidate) => candidate.id === "db.migrations");
      await check?.run(new AbortController().signal);
      const sql = mocks.pgQuery.mock.calls.map(([text]) => text);
      expect(sql.slice(0, 2)).toEqual(["begin read only", "set local role service_role"]);
      expect(sql[2]).toContain("public.pgmigrations");
    });
  });

  describe("RLS gaps", () => {
    const check = async () => byId(await runHealthChecks({ requestHost: "x" }), "db.rls-gaps");

    it("fails with the count, and how to see them", async () => {
      const session = healthySession();
      mocks.pgQuery.mockImplementation(async (sql: string) =>
        (sql.includes("tenant_rls_gaps") ? { rows: [{ gaps: 3 }] } : session(sql)));
      const result = await check();
      expect(result).toMatchObject({ status: "fail", detail: "3 gaps." });
      expect(result.remediation).toContain("select object, problem from app.tenant_rls_gaps()");
    });

    it("warns with only the code when the gate cannot run", async () => {
      const session = healthySession();
      mocks.pgQuery.mockImplementation(async (sql: string) => {
        if (sql.includes("tenant_rls_gaps")) throw failing("no function", "42883");
        return session(sql);
      });
      const result = await check();
      expect(result.status).toBe("warn");
      expect(result.detail).toBe("Could not run the gate (code 42883).");
      expect(result.remediation).toContain("migrations are current");
    });
  });

  describe("service_role bypass", () => {
    const counts = (service: number, install: number, nobody: number): Scenario["postgrest"] => (url, role, tenantId) => {
      if (url.pathname === "/tenants" && url.searchParams.get("select") === "tenant_id") {
        const count = role === "service_role" ? service : tenantId === "tenant-under-test" ? install : nobody;
        return json(200, [], { "content-range": `*/${count}` });
      }
      return healthyPostgrest(url, role, tenantId);
    };
    const check = async () => byId(await runHealthChecks({ requestHost: "x" }), "db.service-role-bypass");

    it("trusts pg_roles when the direct session can read it, whatever the counts", async () => {
      scenario.postgrest = counts(0, 0, 0);
      expect(await check()).toMatchObject({ status: "pass", detail: "pg_roles shows service_role has BYPASSRLS." });
    });

    it("fails on pg_roles even with an empty table, which counts could not see", async () => {
      scenario.postgrest = counts(0, 0, 0);
      mocks.pgQuery.mockImplementation(healthySession({ bypass: [{ rolbypassrls: false }] }));
      const result = await check();
      expect(result.status).toBe("fail");
      expect(result.remediation).toContain("BYPASSRLS");
    });

    it("fails when the role does not exist", async () => {
      mocks.pgQuery.mockImplementation(healthySession({ bypass: [] }));
      const result = await check();
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("does not exist");
    });

    describe("with no direct session", () => {
      beforeEach(() => { mocks.pgConnect.mockRejectedValue(failing("down", "ECONNREFUSED")); });

      it("passes on what the counts prove", async () => {
        scenario.postgrest = counts(3, 1, 0);
        expect((await check()).status).toBe("pass");
      });

      it("fails when service_role sees less than the install tenant", async () => {
        scenario.postgrest = counts(0, 1, 0);
        const result = await check();
        expect(result.status).toBe("fail");
        expect(result.remediation).toContain("BYPASSRLS");
      });

      it("says it could not be proven with no rows, rather than implying all is well", async () => {
        scenario.postgrest = counts(0, 0, 0);
        const result = await check();
        expect(result.status).toBe("info");
        expect(result.detail).toContain("Could not be proven");
      });

      it("fails when a claim for no tenant sees every row", async () => {
        scenario.postgrest = counts(2, 2, 2);
        expect((await check()).status).toBe("fail");
      });
    });

    it("gets the same info when no direct session is configured", async () => {
      vi.stubEnv("STREAM_RUN_DATABASE_URL", "");
      scenario.postgrest = counts(0, 0, 0);
      expect((await check()).status).toBe("info");
    });
  });

  describe("install tenant", () => {
    const check = async () => byId(await runHealthChecks({ requestHost: "x" }), "db.install-tenant");

    it("fails when the database's fallback differs from the configured tenant", async () => {
      scenario.postgrest = (url, role, tenantId) => {
        if (url.pathname === "/rpc/stamp_runtime_metadata") {
          return json(200, { pooled: false, fallback_tenant_id: "someone-else", stamp_id: null, region: null, platform_credentials: [] });
        }
        return healthyPostgrest(url, role, tenantId);
      };
      const result = await check();
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("differs");
      expect(result.detail).not.toContain("someone-else");
      expect(result.remediation).toContain("Install tenant check");
    });

    it("warns when the tenant has no row", async () => {
      scenario.postgrest = (url, role, tenantId) => {
        if (url.pathname === "/tenants" && url.searchParams.get("select") === "status") return json(200, []);
        return healthyPostgrest(url, role, tenantId);
      };
      const result = await check();
      expect(result.status).toBe("warn");
      expect(result.detail).toContain("no row");
    });

    it("fails when the tenant is suspended", async () => {
      scenario.postgrest = (url, role, tenantId) => {
        if (url.pathname === "/tenants" && url.searchParams.get("select") === "status") {
          return json(200, [{ status: "suspended" }]);
        }
        return healthyPostgrest(url, role, tenantId);
      };
      const result = await check();
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("suspended");
    });

    it("names the missing secret, on both checks that need it", async () => {
      vi.stubEnv("ENTRA_TENANT_ID", "");
      const results = await runHealthChecks({ requestHost: "x" });
      for (const id of ["db.install-tenant", "db.data-assignment"]) {
        const result = byId(results, id);
        expect(result.status).toBe("fail");
        expect(result.detail).toContain("entra-tenant-id has no value");
        expect(result.remediation).toContain("Set entra-tenant-id");
      }
    });

    it("does not call a Key Vault outage a missing secret", async () => {
      vi.stubEnv("KEY_VAULT_NAME", "test-vault");
      vi.stubEnv("TENANCY_MODE", "single");
      vi.stubEnv("AUTH_PROVIDER", "entra");
      vi.stubEnv("ENTRA_TENANT_ID", "");
      mocks.kvGet.mockRejectedValue(Object.assign(new Error(SENTINELS.dbMessage), { statusCode: 503 }));
      const result = await check();
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("HTTP 503");
      expect(result.detail).not.toContain("has no value");
    });
  });

  describe("unsigned request", () => {
    const unsigned = (status: number): Scenario["postgrest"] => (url, role, tenantId) =>
      (role ? healthyPostgrest(url, role, tenantId) : json(status, []));
    const check = async () => byId(await runHealthChecks({ requestHost: "x" }), "db.unsigned-rejected");

    it("fails on entra when it is served", async () => {
      scenario.postgrest = unsigned(200);
      const result = await check();
      expect(result.status).toBe("fail");
      expect(result.remediation).toContain("PGRST_DB_ANON_ROLE");
    });

    it("only warns on entra when PostgREST answers with an error, which is not a refusal", async () => {
      scenario.postgrest = unsigned(503);
      expect((await check()).status).toBe("warn");
    });

    it("only warns on local auth when it is served", async () => {
      vi.stubEnv("AUTH_PROVIDER", "local");
      vi.stubEnv("JWT_SECRET", SENTINELS.jwt);
      vi.stubEnv("SUPABASE_SECRET_KEY", "unused-by-the-signing-wrapper");
      scenario.postgrest = unsigned(200);
      const result = await check();
      expect(result.status).toBe("warn");
      expect(result.remediation).toContain("web_anon");
    });
  });

  it("does not claim signing on hosted Supabase", async () => {
    vi.stubEnv("AUTH_PROVIDER", "supabase");
    vi.stubEnv("SUPABASE_SECRET_KEY", "a-hosted-key");
    const results = await runHealthChecks({ requestHost: "x" });
    for (const id of ["db.postgrest-signed", "db.unsigned-rejected", "db.tenant-role", "db.service-role-bypass"]) {
      expect(byId(results, id).status).toBe("skip");
    }
  });

  describe("providers", () => {
    const check = async () => byId(await runHealthChecks({ requestHost: "x" }), "providers.credentials");

    it("does not count CourtListener as an LLM provider", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "");
      vi.stubEnv("COURTLISTENER_API_TOKEN", "a-courtlistener-token-of-a-plausible-length-000000");
      const result = await check();
      expect(result.status).toBe("warn");
      expect(result.detail).toContain("Configured: none.");
      expect(result.detail).toContain("Not an LLM provider: CourtListener");
      expect(result.remediation).toContain("at least one LLM provider");
    });

    it("reports a Key Vault outage as unknown, not as nothing configured", async () => {
      vi.stubEnv("KEY_VAULT_NAME", "test-vault");
      vi.stubEnv("TENANCY_MODE", "single");
      vi.stubEnv("ANTHROPIC_API_KEY", "");
      mocks.kvGet.mockRejectedValue(Object.assign(new Error(SENTINELS.dbMessage), { statusCode: 503 }));
      const result = await check();
      expect(result.status).toBe("warn");
      expect(result.detail).toContain("Unknown, could not be read:");
      expect(result.detail).not.toContain(SENTINELS.dbMessage);
      expect(result.remediation).toContain("Key Vault");
      expect(result.remediation).not.toContain("Add at least one");
    });

    it("reports a key with a bad format as present but invalid, not as not configured", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "not-the-form-anthropic-issues");
      const result = await check();
      expect(result.status).toBe("warn");
      expect(result.detail).toContain("Present but invalid format: Anthropic API key.");
      expect(result.detail).not.toMatch(/Not configured:[^.]*Anthropic/);
      expect(result.detail).not.toContain("not-the-form");
      expect(result.remediation).toContain("Replace those values");
      expect(result.remediation).not.toContain("Add at least one");
    });

    it("warns about a bad format even when another provider is configured", async () => {
      vi.stubEnv("OPENROUTER_API_KEY", "not-the-form-openrouter-issues");
      const result = await check();
      expect(result.status).toBe("warn");
      expect(result.detail).toContain("Configured: Anthropic API key.");
      expect(result.detail).toContain("Present but invalid format: OpenRouter API key.");
    });

    it("names TokenJuice and Meta, as configured only once complete and without their values", async () => {
      vi.stubEnv("TOKENJUICE_API_KEY", "secret-tokenjuice-value");
      vi.stubEnv("TOKENJUICE_MODELS", "juice-large");
      vi.stubEnv("TOKENJUICE_BASE_URL", "");
      vi.stubEnv("META_API_KEY", "secret-meta-value");
      vi.stubEnv("META_MODELS", "muse-spark-1.1");
      vi.stubEnv("META_BASE_URL", "");
      const partial = await check();
      expect(partial.detail).toMatch(/Configured: [^.]*Meta \(Muse\)/);
      expect(partial.detail).toMatch(/Not configured: [^.]*TokenJuice/);
      vi.stubEnv("TOKENJUICE_BASE_URL", "ftp://tj.example.test");
      expect((await check()).detail).toContain("Present but invalid format: TokenJuice.");
      resetHealthRunForTests();
      vi.stubEnv("TOKENJUICE_BASE_URL", "https://tj.example.test/v1");
      const complete = await check();
      expect(complete.detail).toMatch(/Configured: [^.]*TokenJuice/);
      for (const value of ["secret-tokenjuice-value", "secret-meta-value", "tj.example.test", "juice-large"]) {
        expect(complete.detail).not.toContain(value);
      }
    });

    it("treats a vault's 404 as a real absence", async () => {
      vi.stubEnv("KEY_VAULT_NAME", "test-vault");
      vi.stubEnv("TENANCY_MODE", "single");
      vi.stubEnv("ANTHROPIC_API_KEY", "");
      const result = await check();
      expect(result.detail).not.toContain("Unknown");
      expect(result.remediation).toContain("at least one LLM provider");
    });

    it("treats a missing vault as absence, not an outage", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "");
      const result = await check();
      expect(result.detail).not.toContain("Unknown");
    });
  });

  describe("required secrets", () => {
    const check = async () => byId(await runHealthChecks({ requestHost: "x" }), "config.required-secrets");

    it("accepts API_PUBLIC_URL for backend-public-url, as startup does", async () => {
      vi.stubEnv("BACKEND_PUBLIC_URL", "");
      vi.stubEnv("API_PUBLIC_URL", "https://backend.example.test");
      expect((await check()).status).toBe("pass");
    });

    it("still reports backend-public-url when neither is set", async () => {
      vi.stubEnv("BACKEND_PUBLIC_URL", "");
      const result = await check();
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("Missing: backend-public-url.");
      expect(result.remediation).toContain("within about 5 minutes");
      expect(result.remediation).not.toContain("new backend revision.");
    });

    it("asks for a new revision for a key read only at startup, because the config cache does not reach it", async () => {
      vi.stubEnv("AUTH_STATE_SECRET", "__unset__");
      const result = await check();
      expect(result.detail).toContain("Missing: auth-state-secret.");
      expect(result.remediation).toContain("Set auth-state-secret, then create a new backend revision");
      expect(result.remediation).not.toContain("within about 5 minutes");
    });

    it.each([
      ["local", "jwt-secret, supabase-url"],
      ["supabase", "supabase-url, supabase-secret-key"],
    ])("asks for a new revision on %s auth for %s, which runtime reads only from the environment", async (provider, names) => {
      vi.stubEnv("AUTH_PROVIDER", provider);
      for (const envName of ["JWT_SECRET", "SUPABASE_URL", "SUPABASE_SECRET_KEY"]) vi.stubEnv(envName, "");
      const result = await check();
      expect(result.detail).toContain(`Missing: ${names}.`);
      expect(result.remediation).toContain(`Set ${names}, then create a new backend revision`);
      expect(result.remediation).toContain("from its environment");
      expect(result.remediation).not.toContain("within about 5 minutes");
    });

    it("gives each missing name its own route when one is cached and one is not", async () => {
      vi.stubEnv("BACKEND_PUBLIC_URL", "");
      vi.stubEnv("AUTH_STATE_SECRET", "__unset__");
      const result = await check();
      expect(result.remediation).toContain("Set backend-public-url in Key Vault, and it takes effect within about 5 minutes");
      expect(result.remediation).toContain("Set auth-state-secret, then create a new backend revision");
    });

    it("asks for a new PostgREST revision for postgrest-jwt-secret, though the backend's cache picks it up", async () => {
      vi.stubEnv("POSTGREST_JWT_SECRET", "__unset__");
      const result = await check();
      expect(result.detail).toContain("Missing: postgrest-jwt-secret.");
      expect(result.remediation).toContain("within about 5 minutes");
      expect(result.remediation).toContain("postgrest-jwt-secret also needs a new PostgREST revision");
    });
  });

  it("leaks nothing in HTML or JSON when everything is healthy", async () => {
    const html = await page();
    const body = await page("&format=json");
    expect(html.status).toBe(200);
    expect(body.status).toBe(200);
    expectNoSentinel(html.text);
    expectNoSentinel(body.text);
    expect(body.body.checks.length).toBeGreaterThan(20);
    for (const check of body.body.checks) {
      expect(Object.keys(check).sort().filter((key) => key !== "remediation"))
        .toEqual(["detail", "group", "id", "status", "title"]);
      expect(["pass", "warn", "fail", "info", "skip"]).toContain(check.status);
    }
  });

  it("leaks nothing when every dependency fails with sentinel text", async () => {
    const error = { code: "42501", message: `${SENTINELS.dbMessage} ${CONNECTION}`, details: SENTINELS.rowContent };
    scenario = {
      entra: () => json(401, { error_codes: [7000222], error_description: `AADSTS7000222: ${SENTINELS.entraDescription} ${SENTINELS.clientSecret}` }),
      graph: () => json(403, { error: { code: "Authorization_RequestDenied", message: SENTINELS.entraDescription } }),
      postgrest: () => json(403, error),
    };
    mocks.pgQuery.mockReset().mockRejectedValue(Object.assign(new Error(`${SENTINELS.dbMessage} ${CONNECTION}`), { code: "42501" }));
    mocks.listFiles.mockReset().mockRejectedValue(new Error(`${SENTINELS.dbMessage} AccountKey=${SENTINELS.provider}`));
    mocks.graphToken.mockReset().mockRejectedValue(new Error(`${SENTINELS.graphToken} failed`));
    const html = await page();
    const body = await page("&format=json");
    expect(html.status).toBe(200);
    expectNoSentinel(html.text);
    expectNoSentinel(body.text);
    const results = body.body.checks as HealthResult[];
    expect(byId(results, "entra.client-secret")).toMatchObject({ status: "fail" });
    expect(byId(results, "entra.client-secret").detail).toContain("AADSTS7000222");
    expect(byId(results, "db.tenant-role").status).toBe("fail");
    expect(byId(results, "db.tenant-role").detail).toContain("42501");
    expect(byId(results, "db.tenant-role").remediation).toContain("GRANT tenant_app TO <login>");
    expect(byId(results, "db.stream-login").status).toBe("fail");
    for (const result of results) {
      if (result.status === "warn" || result.status === "fail") expect(result.remediation).toBeTruthy();
    }
  });

  it("gives info with an unknown date when Graph denies access", async () => {
    scenario.graph = () => json(403, { error: { code: "Authorization_RequestDenied", message: "nope" } });
    // The redirect URI check waits out a 403, in case a grant is still propagating.
    const results = await withoutRetryDelays(() => runHealthChecks({ requestHost: "x" }));
    const expiry = byId(results, "entra.client-secret-expiry");
    expect(expiry.status).toBe("info");
    expect(expiry.detail).toContain("unknown");
    expect(expiry.detail).toContain("403");
  });

  it("gives info when the managed identity cannot get a Graph token", async () => {
    mocks.graphToken.mockReset().mockRejectedValue(new Error("no identity"));
    const results = await runHealthChecks({ requestHost: "x" });
    expect(byId(results, "entra.client-secret-expiry").status).toBe("info");
    expect(byId(results, "entra.redirect-uris").status).toBe("info");
  });

  it("names missing redirect URIs for the configured public host, not the request's", async () => {
    scenario.graph = () => json(200, { passwordCredentials: [], web: { redirectUris: [] }, spa: { redirectUris: [] } });
    const uris = byId(await runHealthChecks({ requestHost: "ignored.example.test" }), "entra.redirect-uris");
    expect(uris.status).toBe("fail");
    expect(uris.detail).toContain("https://backend.example.test/login");
    expect(uris.detail).not.toContain("ignored.example.test");
    expect(uris.remediation).toContain("register-redirect-uris.ps1");
    expect(uris.remediation).toContain("-BackendFqdn backend.example.test");
  });

  it("identifies an expired secret from Entra and from Graph", async () => {
    scenario.entra = () => json(401, { error_codes: [7000222] });
    scenario.graph = () => json(200, {
      passwordCredentials: [{ hint: SENTINELS.clientSecret.slice(0, 3), endDateTime: "2020-01-01T00:00:00Z" }],
    });
    const results = await runHealthChecks({ requestHost: "x" });
    expect(byId(results, "entra.client-secret").status).toBe("fail");
    expect(byId(results, "entra.client-secret-expiry").status).toBe("fail");
  });

  it("flags rows under another tenant on a single install, as counts", async () => {
    scenario.postgrest = (url, role) => {
      if (url.pathname === "/projects" && url.searchParams.has("tenant_id")) {
        return json(200, [], { "content-range": "*/7" });
      }
      if (["/documents", "/user_profiles"].includes(url.pathname)) return json(200, [], { "content-range": "*/0" });
      return healthyPostgrest(url, role);
    };
    const results = await runHealthChecks({ requestHost: "x" });
    const assignment = byId(results, "db.data-assignment");
    expect(assignment.status).toBe("fail");
    expect(assignment.detail).toContain("projects 7");
  });

  it("warns when the oldest due job is older than 15 minutes", async () => {
    scenario.postgrest = (url, role) => {
      if (url.pathname === "/db_jobs" && url.searchParams.get("select") === "run_at") {
        return json(200, [{ run_at: new Date(Date.now() - 20.5 * 60_000).toISOString() }]);
      }
      return healthyPostgrest(url, role);
    };
    const queue = byId(await runHealthChecks({ requestHost: "x" }), "worker.queue");
    expect(queue.status).toBe("warn");
    expect(queue.detail).toContain("20 min");
  });

  it("skips direct-connection checks when no connection is configured", async () => {
    vi.stubEnv("STREAM_RUN_DATABASE_URL", "");
    const results = await runHealthChecks({ requestHost: "x" });
    for (const id of ["db.migrations", "db.rls-gaps", "db.stream-login"]) {
      expect(byId(results, id).status).toBe("skip");
    }
  });

  it("skips Entra checks on another auth provider", async () => {
    vi.stubEnv("AUTH_PROVIDER", "local");
    vi.stubEnv("JWT_SECRET", SENTINELS.jwt);
    vi.stubEnv("SUPABASE_SECRET_KEY", "unused-by-the-signing-wrapper");
    const results = await runHealthChecks({ requestHost: "x" });
    for (const id of ["entra.client-secret", "entra.client-secret-expiry", "entra.redirect-uris"]) {
      expect(byId(results, id).status).toBe("skip");
    }
    expect(outbound.filter((call) => call.includes("microsoft"))).toEqual([]);
  });

  it("warns about the rollback switch without failing the tenant role check", async () => {
    vi.stubEnv("TENANT_RLS_ENFORCED", "false");
    const results = await runHealthChecks({ requestHost: "x" });
    expect(byId(results, "config.tenant-rls").status).toBe("warn");
    expect(byId(results, "db.tenant-role")).toMatchObject({ status: "pass", detail: "Tenant traffic can read as role service_role." });
  });
});
