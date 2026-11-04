// Issue 025: the diagnostics pages fail closed. They are mounted on the public
// backend, so an unset DIAGNOSTICS_TOKEN must not mean "open".

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  runDiagnostics: vi.fn(async () => []),
  inspectRows: vi.fn(async () => ({ rows: [], queryError: null })),
}));
vi.mock("./platform.service", () => service);

import { diagnosticsRouter } from "./diagnostics.routes";

const TOKEN = "a-diagnostics-token-for-tests";
const PAGES = ["/api/admin/diagnostics/postgrest", "/api/admin/diagnostics/inspect?table=projects"];
const saved = { token: process.env.DIAGNOSTICS_TOKEN, provider: process.env.AUTH_PROVIDER, jwt: process.env.JWT_SECRET };

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function app() {
  const server = express();
  server.use("/api/admin/diagnostics", diagnosticsRouter);
  return server;
}

function withToken(path: string, token: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}token=${encodeURIComponent(token)}`;
}

function expectNothingRan(): void {
  expect(service.runDiagnostics).not.toHaveBeenCalled();
  expect(service.inspectRows).not.toHaveBeenCalled();
}

beforeEach(() => {
  delete process.env.DIAGNOSTICS_TOKEN;
  vi.clearAllMocks();
});

afterEach(() => {
  restore("DIAGNOSTICS_TOKEN", saved.token);
  restore("AUTH_PROVIDER", saved.provider);
  restore("JWT_SECRET", saved.jwt);
});

describe.each(PAGES)("%s", (page) => {
  it("does not exist when no token is configured", async () => {
    const response = await request(app()).get(page);
    expect(response.status).toBe(404);
    expectNothingRan();
  });

  it("does not exist for a guessed token when none is configured", async () => {
    const response = await request(app()).get(withToken(page, "anything"));
    expect(response.status).toBe(404);
    expectNothingRan();
  });

  it("treats a blank configured token as not configured", async () => {
    process.env.DIAGNOSTICS_TOKEN = "   ";
    const response = await request(app()).get(withToken(page, "   "));
    expect(response.status).toBe(404);
    expectNothingRan();
  });

  it.each([
    ["no", (path: string) => path],
    ["a wrong", (path: string) => withToken(path, "wrong")],
    ["a same-length wrong", (path: string) => withToken(path, TOKEN.replace(/.$/, "!"))],
    ["a longer", (path: string) => withToken(path, `${TOKEN}x`)],
    ["a repeated", (path: string) => `${withToken(path, TOKEN)}&token=${TOKEN}`],
  ])("refuses %s token", async (_label, build) => {
    process.env.DIAGNOSTICS_TOKEN = TOKEN;
    const response = await request(app()).get(build(page));
    expect(response.status).toBe(401);
    expectNothingRan();
  });

  it("serves the right token", async () => {
    process.env.DIAGNOSTICS_TOKEN = TOKEN;
    const response = await request(app()).get(withToken(page, TOKEN));
    expect(response.status).toBe(200);
    expect(response.text).toContain("<html");
  });
});

describe("chat inspector", () => {
  it.each(["/api/admin/diagnostics/chats", "/api/admin/diagnostics/chats/chat-1/trace"])(
    "%s needs application authentication whatever the diagnostics token",
    async (path) => {
      process.env.AUTH_PROVIDER = "local";
      process.env.JWT_SECRET = "a-jwt-secret-for-the-diagnostics-route-test";
      const response = await request(app()).get(path);
      expect(response.status).toBe(401);
    },
  );
});
