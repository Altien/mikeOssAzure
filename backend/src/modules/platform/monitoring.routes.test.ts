// Upstream's frontend/src/app/monitoring/route.test.ts, carried to Dev's
// backend tunnel (sync-log: 3bcac35a). Baked NEXT_PUBLIC_* cases are not
// carried: Dev's web DSN is runtime-only.
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vault = vi.hoisted(() => vi.fn());
vi.mock("../../lib/config", () => ({ getKeyVaultConfig: vault }));

import { MAX_ENVELOPE_BYTES } from "../../lib/observability/sentryTunnel";
import { monitoringRouter } from "./monitoring.routes";

const decoder = new TextDecoder();
const OWN_DSN = "https://abc123@o777.ingest.us.sentry.io/4242";

function envelope(lines: (string | object)[]): string {
  return lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";
}

function parsedLines(bytes: Uint8Array): unknown[] {
  return decoder.decode(bytes).split("\n").filter(Boolean).map((l) => JSON.parse(l) as unknown);
}

const app = express().use("/api/monitoring", monitoringRouter);
const post = (body: string, headers: Record<string, string> = {}) =>
  request(app)
    .post("/api/monitoring")
    .set({ "content-type": "text/plain;charset=UTF-8", ...headers })
    .send(body);

describe("POST /api/monitoring", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vault.mockReset();
    vault.mockRejectedValue(new Error("No vault configured"));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SENTRY_DISABLED", "");
    vi.stubEnv("SENTRY_FRONTEND_DSN", "");
    vi.stubEnv("SENTRY_ENVIRONMENT", "");
    vi.stubEnv("SENTRY_INSTALL", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("forwards the rewritten envelope to the runtime DSN and relays the status", async () => {
    vi.stubEnv("SENTRY_FRONTEND_DSN", OWN_DSN);
    vi.stubEnv("SENTRY_ENVIRONMENT", "production");
    fetchMock.mockResolvedValue(
      new Response("{}", { status: 429, headers: { "retry-after": "60", "x-sentry-rate-limits": "60::" } }),
    );
    const response = await post(
      envelope([{ dsn: "https://client@o1.ingest.sentry.io/1" }, { type: "event" }, { event_id: "c".repeat(32) }]),
    );
    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("60");
    expect(response.headers["x-sentry-rate-limits"]).toBe("60::");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://o777.ingest.us.sentry.io/api/4242/envelope/");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(parsedLines(new Uint8Array(init.body as ArrayBuffer))).toEqual([
      { dsn: OWN_DSN },
      { type: "event" },
      { event_id: "c".repeat(32), environment: "production" },
    ]);
  });

  it("uses the Key Vault web DSN before the environment fallback", async () => {
    vault.mockImplementation(async (name: string) => (name === "sentry-frontend-dsn" ? OWN_DSN : ""));
    vi.stubEnv("SENTRY_FRONTEND_DSN", "https://stale@o1.ingest.sentry.io/1");
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    expect((await post(envelope([{ dsn: "x" }, { type: "event" }, {}]))).status).toBe(200);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://o777.ingest.us.sentry.io/api/4242/envelope/");
  });

  it("answers 204 and sends nothing when the deployment is opted out", async () => {
    vi.stubEnv("SENTRY_DISABLED", "true");
    vi.stubEnv("SENTRY_FRONTEND_DSN", OWN_DSN);
    const response = await post(envelope([{ dsn: "x" }, { type: "event" }, {}]));
    expect(response.status).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 204 when no web DSN is configured (Dev has no default destination)", async () => {
    const response = await post(envelope([{ dsn: "x" }, { type: "event" }, {}]));
    expect(response.status).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects oversized, empty and unparseable envelopes without forwarding", async () => {
    vi.stubEnv("SENTRY_FRONTEND_DSN", OWN_DSN);
    expect((await post("x".repeat(MAX_ENVELOPE_BYTES + 1))).status).toBe(413);
    expect((await post("")).status).toBe(400);
    expect((await post("not an envelope\n")).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 502 when Sentry is unreachable", async () => {
    vi.stubEnv("SENTRY_FRONTEND_DSN", OWN_DSN);
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await post(envelope([{ dsn: "x" }, { type: "event" }, {}]));
    expect(response.status).toBe(502);
    warn.mockRestore();
  });

  it("still relays Sentry's 200 when releasing the response stream fails", async () => {
    vi.stubEnv("SENTRY_FRONTEND_DSN", OWN_DSN);
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        throw new Error("already closed");
      },
    });
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await post(envelope([{ dsn: "x" }, { type: "event" }, {}]));
    expect(response.status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("answers GET with the rule that decides the destination, never the DSN", async () => {
    vi.stubEnv("SENTRY_FRONTEND_DSN", OWN_DSN);
    const response = await request(app).get("/api/monitoring");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.reports).toBe("runtime");
    expect(JSON.stringify(response.body)).not.toContain("abc123");
    vi.stubEnv("SENTRY_DISABLED", "true");
    expect((await request(app).get("/api/monitoring")).body.reports).toBe("disabled");
    vi.stubEnv("SENTRY_DISABLED", "");
    vi.stubEnv("SENTRY_FRONTEND_DSN", "");
    expect((await request(app).get("/api/monitoring")).body.reports).toBe("none");
  });
});
