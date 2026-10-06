import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

// The route is registered behind an env flag.
// Dev drift: Dev's buildApp() reads the flag per call, so a static import works
// and the cold app-graph transform is paid at collection, not in a 10s hook.
const reportError = vi.hoisted(() => vi.fn(() => "event-1"));
const reportMessage = vi.hoisted(() => vi.fn(() => "event-2"));
const tagCurrentRequest = vi.hoisted(() => vi.fn());
vi.mock("../../lib/observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/observability/sentry")>()),
  reportError,
  reportMessage,
  tagCurrentRequest,
  setCurrentUser: vi.fn(),
}));

import type { Express } from "express";
import { buildApp } from "../../app";

let app: Express;

beforeAll(() => {
  process.env.SENTRY_ENABLE_TEST_ROUTE = "true";
  app = buildApp();
});

afterAll(() => {
  delete process.env.SENTRY_ENABLE_TEST_ROUTE;
});

describe("GET /api/observability/sentry-test", () => {
  it("throws through the real 500 path and reports with the response's request id", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    // Dev drift: Dev mounts the probe under /api
    const res = await request(app).get("/api/observability/sentry-test");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      code: "internal_error",
      detail: "Something went wrong. Please try again.",
      request_id: res.headers["x-request-id"],
    });
    // The id was attached to the Sentry scope by the request-id middleware…
    expect(tagCurrentRequest).toHaveBeenCalledWith(res.headers["x-request-id"]);
    // …and the thrown error reached the reporter through handleUnhandledError.
    expect(reportError).toHaveBeenCalledOnce();
    const [error, context] = reportError.mock.calls[0] as unknown as [
      Error,
      { tags: Record<string, unknown> },
    ];
    expect(error.message).toContain("Sentry backend test error");
    expect(error).toHaveProperty("code", "sentry_test");
    expect(context.tags).toMatchObject({
      component: "http",
      http_status: 500,
      request_id: res.headers["x-request-id"],
      http_method: "GET",
    });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
