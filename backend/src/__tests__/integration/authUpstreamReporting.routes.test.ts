// MIK-125: one GoTrue outage used to file three Sentry issues per auth route
// (authError's reportError, the response sanitizer's reportMessage, and the
// console bridge's copy of the sanitizer's console.error). This drives the
// real auth router behind the real sanitizer, with a real Supabase client
// pointed at a closed port and a real Sentry client whose transport records
// every event, so each of the three paths is counted where it is produced.
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import * as Sentry from "@sentry/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSentryForTests, scrubEvent } from "../../lib/observability/sentry";
import { privacyBoundaryIntegration } from "../../lib/observability/sentryPrivacy";
import { requireAuth } from "../../middleware/auth";
import { protectInternalErrorResponses } from "../../middleware/internalErrorResponse";
import { authRouter } from "../../modules/auth/auth.routes";

const origin = "https://app.example.test";
const saved: Record<string, string | undefined> = {};
const ENV = {
  FRONTEND_URL: origin,
  // Port 9 (discard) is closed on CI runners and dev machines: auth-js gets
  // ECONNREFUSED and turns it into an AuthRetryableFetchError (status 0).
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
  SUPABASE_SECRET_KEY: "test-secret-key",
};

const events: Sentry.ErrorEvent[] = [];

// A GoTrue that is up and failing on something of ours, the way a broken
// auth.users trigger or a missing migration makes it answer sign-up.
const brokenGoTrue = http.createServer((_req, res) => {
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: 500, msg: "Database error saving new user" }));
});

beforeAll(async () => {
  await new Promise<void>((resolve) => brokenGoTrue.listen(0, "127.0.0.1", resolve));
  for (const [key, value] of Object.entries(ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});
afterAll(async () => {
  await new Promise<void>((resolve) => brokenGoTrue.close(() => resolve()));
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  events.length = 0;
  resetSentryForTests("community", { initialized: true });
  Sentry.init({
    dsn: "https://test@sentry.invalid/1",
    defaultIntegrations: false,
    integrations: [
      privacyBoundaryIntegration(),
      Sentry.captureConsoleIntegration({ levels: ["error"] }),
    ],
    beforeSend: scrubEvent,
    transport: () => ({
      send: async (envelope) => {
        for (const [header, payload] of envelope[1]) {
          if (header.type === "event") events.push(payload as Sentry.ErrorEvent);
        }
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
  // Keep the test output quiet; the bridge still sees console.error calls
  // because captureConsoleIntegration wraps the (spied) method.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  await Sentry.close();
  resetSentryForTests("community");
  vi.restoreAllMocks();
});

function app() {
  const server = express();
  server.use((_req, res, next) => {
    res.locals.requestId = "req-auth-outage";
    next();
  });
  server.use(protectInternalErrorResponses);
  server.use(express.json());
  server.use("/auth", authRouter);
  server.get("/projects", requireAuth, (_req, res) => {
    res.json({ ok: true });
  });
  return server;
}

it("answers an unreachable GoTrue with 503 upstream_unavailable and files exactly one event", async () => {
  const res = await request(app())
    .post("/auth/login")
    .set("Origin", origin)
    .send({ email: "lawyer@example.test", password: "correct horse battery" });
  await Sentry.flush(2000);

  expect(res.status).toBe(503);
  expect(res.body).toEqual({
    code: "upstream_unavailable",
    detail: "The server is temporarily unreachable. Please try again shortly.",
    request_id: "req-auth-outage",
  });

  const exceptions = events.filter((event) => event.logger !== "console" && event.exception);
  const messages = events.filter((event) => event.logger !== "console" && !event.exception);
  const bridged = events.filter((event) => event.logger === "console");
  expect({ exceptions: exceptions.length, messages: messages.length, bridged: bridged.length })
    .toEqual({ exceptions: 1, messages: 0, bridged: 0 });
  expect(exceptions[0]!.tags).toMatchObject({
    operation: "auth.signin",
    // Dev keeps its existing kind for a Supabase-provider auth failure.
    error_kind: "auth.session_lookup_failed",
    http_status: 503,
  });
});

it("keeps a GoTrue 500 a reported 500, not an outage the user should wait out", async () => {
  const { port } = brokenGoTrue.address() as AddressInfo;
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  try {
    const res = await request(app())
      .post("/auth/login")
      .set("Origin", origin)
      .send({ email: "lawyer@example.test", password: "correct horse battery" });
    await Sentry.flush(2000);

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: "internal_error", request_id: "req-auth-outage" });
    const reported = events.filter((event) => event.logger !== "console");
    expect(reported).toHaveLength(1);
    // Dev divergence (sync-log: 3e4ab0b0): Dev's authError files every
    // provider 5xx as auth.session_lookup_failed (see the outage test above).
    expect(reported[0]!.tags).toMatchObject({
      error_kind: "auth.session_lookup_failed",
      http_status: 500,
    });
    expect(events.filter((event) => event.logger === "console")).toHaveLength(0);
  } finally {
    process.env.SUPABASE_URL = ENV.SUPABASE_URL;
  }
});

describe("requireAuth with GoTrue unreachable", () => {
  function jwt(exp: number): string {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "u1", exp, aud: "authenticated", role: "authenticated" })}.signature`;
  }
  const exp = Math.floor(Date.now() / 1000) + 3600;

  // Dev divergence (sync-log: 08bdc1d9): Dev's cookie is an opaque server
  // session (lib/serverSession.ts) whose stored token is validated by the
  // same validateSupabaseToken call as a bearer token, so upstream's
  // Supabase-cookie case is covered by the bearer case and not repeated.
  it.each([
    ["a bearer token", (req: request.Test) => req.set("Authorization", `Bearer ${jwt(exp)}`)],
  ])("answers %s 503 upstream_unavailable, not a 401 that signs the user out", async (_label, authenticate) => {
    const res = await authenticate(request(app()).get("/projects"));
    await Sentry.flush(2000);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      code: "upstream_unavailable",
      detail: "The server is temporarily unreachable. Please try again shortly.",
      request_id: "req-auth-outage",
    });
    // The session is kept: no cleared cookie on the way back.
    expect(String(res.headers["set-cookie"] ?? "")).not.toContain("Max-Age=0");
    const reported = events.filter((event) => event.logger !== "console");
    expect(reported).toHaveLength(1);
    expect(reported[0]!.tags).toMatchObject({
      error_kind: "auth.supabase_unavailable",
      http_status: 503,
    });
    expect(events.filter((event) => event.logger === "console")).toHaveLength(0);
  });
});
