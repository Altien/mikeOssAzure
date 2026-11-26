// Issue 025: the diagnostics pages fail closed. They are mounted on the public
// backend, so an unset token must not mean "open". /diag has its own passphrase, so
// enabling it does not also unlock the page that writes and the one returning rows.

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  runDiagnostics: vi.fn(async () => []),
  inspectRows: vi.fn(async () => ({ rows: [], queryError: null })),
  runHealthChecks: vi.fn(async (): Promise<unknown[]> => []),
}));
vi.mock("./platform.service", () => service);

import { buildApp } from "../../app";
import { diagnosticsRouter } from "./diagnostics.routes";

const TOKEN = "a-diagnostics-token-for-tests";
const OTHER_TOKEN = "a-different-token-for-the-other-pages";
const OLD_HEALTH = "/api/admin/diagnostics/health";
const TOKEN_ENV = "DIAGNOSTICS_TOKEN";
const HEALTH_ENV = "DIAGNOSTICS_HEALTH_TOKEN";
const PAGES: Array<[string, string]> = [
  ["/api/admin/diagnostics/postgrest", TOKEN_ENV],
  ["/api/admin/diagnostics/inspect?table=projects", TOKEN_ENV],
];
const saved = {
  token: process.env.DIAGNOSTICS_TOKEN,
  health: process.env.DIAGNOSTICS_HEALTH_TOKEN,
  provider: process.env.AUTH_PROVIDER,
  jwt: process.env.JWT_SECRET,
};

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

function postDiag(server: express.Express, fields: Record<string, string> | string) {
  return request(server).post("/diag").type("form").send(fields);
}

function expectNothingRan(): void {
  expect(service.runDiagnostics).not.toHaveBeenCalled();
  expect(service.inspectRows).not.toHaveBeenCalled();
  expect(service.runHealthChecks).not.toHaveBeenCalled();
}

beforeEach(() => {
  delete process.env.DIAGNOSTICS_TOKEN;
  delete process.env.DIAGNOSTICS_HEALTH_TOKEN;
  vi.clearAllMocks();
});

afterEach(() => {
  restore(TOKEN_ENV, saved.token);
  restore(HEALTH_ENV, saved.health);
  restore("AUTH_PROVIDER", saved.provider);
  restore("JWT_SECRET", saved.jwt);
});

describe.each(PAGES)("%s (%s)", (page, envName) => {
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
    process.env[envName] = "   ";
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
    process.env[envName] = TOKEN;
    const response = await request(app()).get(build(page));
    expect(response.status).toBe(401);
    expectNothingRan();
  });

  it("serves the right token", async () => {
    process.env[envName] = TOKEN;
    const response = await request(app()).get(withToken(page, TOKEN));
    expect(response.status).toBe(200);
    expect(response.text).toContain("<html");
  });
});

describe("the two tokens do not open each other's pages", () => {
  it("DIAGNOSTICS_TOKEN alone leaves /diag absent", async () => {
    process.env.DIAGNOSTICS_TOKEN = TOKEN;
    const server = buildApp();
    expect((await request(server).get("/diag")).status).toBe(404);
    expect((await postDiag(server, { passphrase: TOKEN })).status).toBe(404);
    expectNothingRan();
  });

  it("/diag refuses DIAGNOSTICS_TOKEN when both are set", async () => {
    process.env.DIAGNOSTICS_TOKEN = OTHER_TOKEN;
    process.env.DIAGNOSTICS_HEALTH_TOKEN = TOKEN;
    const response = await postDiag(buildApp(), { passphrase: OTHER_TOKEN });
    expect(response.status).toBe(401);
    expectNothingRan();
  });

  it.each(["/api/admin/diagnostics/postgrest", "/api/admin/diagnostics/inspect?table=projects"])(
    "DIAGNOSTICS_HEALTH_TOKEN alone leaves %s absent",
    async (page) => {
      process.env.DIAGNOSTICS_HEALTH_TOKEN = TOKEN;
      const response = await request(app()).get(withToken(page, TOKEN));
      expect(response.status).toBe(404);
      expectNothingRan();
    },
  );

  it.each(["/api/admin/diagnostics/postgrest", "/api/admin/diagnostics/inspect?table=projects"])(
    "%s refuses DIAGNOSTICS_HEALTH_TOKEN when both are set",
    async (page) => {
      process.env.DIAGNOSTICS_TOKEN = OTHER_TOKEN;
      process.env.DIAGNOSTICS_HEALTH_TOKEN = TOKEN;
      const response = await request(app()).get(withToken(page, TOKEN));
      expect(response.status).toBe(401);
      expectNothingRan();
    },
  );
});

describe("health page at /diag", () => {
  const SHELL = "<html><body>the frontend shell</body></html>";
  const checks = [
    { id: "a.pass", group: "Group A", title: "Passes", status: "pass", detail: "Fine." },
    { id: "b.warn", group: "Group B", title: "Warns", status: "warn", detail: "Soon.", remediation: "Do this." },
    { id: "a.fail", group: "Group A", title: "Fails", status: "fail", detail: "Broken.", remediation: "Do that." },
  ];
  let publicDir: string;

  function expectHealthHeaders(response: request.Response): void {
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  }

  beforeAll(() => {
    publicDir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-shell-"));
    fs.writeFileSync(path.join(publicDir, "index.html"), SHELL);
  });

  afterAll(() => {
    fs.rmSync(publicDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.DIAGNOSTICS_HEALTH_TOKEN = TOKEN;
    service.runHealthChecks.mockResolvedValue(checks);
    // Every test behind the real static fallback, so a miss would serve the shell.
    vi.stubEnv("FRONTEND_PUBLIC_DIR", publicDir);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("serves the frontend shell for an unknown address, so the 404s below mean something", async () => {
    const response = await request(buildApp()).get("/some-frontend-page");
    expect(response.text).toContain("the frontend shell");
  });

  it("shows a password form that posts to /diag and runs no checks", async () => {
    const response = await request(buildApp()).get("/diag");
    expect(response.status).toBe(200);
    expect(response.type).toBe("text/html");
    expect(response.text).toContain('<form method="post" action="/diag">');
    expect(response.text).toContain('name="passphrase"');
    expect(response.text).toContain('type="password"');
    expect(response.text).not.toContain("Wrong passphrase");
    expect(response.text).not.toContain(TOKEN);
    expectNothingRan();
  });

  it("does not open from a passphrase in the URL", async () => {
    const server = buildApp();
    const get = await request(server).get(`/diag?passphrase=${TOKEN}&token=${TOKEN}`);
    expect(get.status).toBe(200);
    expect(get.text).toContain('name="passphrase"');
    expect((await request(server).post(`/diag?passphrase=${TOKEN}&token=${TOKEN}`)).status).toBe(401);
    expectNothingRan();
  });

  it.each([["unset", undefined], ["blank", "   "]])("does not exist when the env var is %s", async (_label, value) => {
    if (value === undefined) delete process.env.DIAGNOSTICS_HEALTH_TOKEN;
    else process.env.DIAGNOSTICS_HEALTH_TOKEN = value;
    const server = buildApp();
    const responses = [
      await request(server).get("/diag"),
      await postDiag(server, { passphrase: TOKEN }),
      await postDiag(server, { passphrase: "   " }),
      await postDiag(server, ""),
    ];
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.text).not.toContain("the frontend shell");
      expect(response.text).not.toContain('name="passphrase"');
      expectHealthHeaders(response);
    }
    expectNothingRan();
  });

  it.each([
    ["no", ""],
    ["an empty", "passphrase="],
    ["a wrong", "passphrase=wrong"],
    ["a same-length wrong", `passphrase=${TOKEN.replace(/.$/, "!")}`],
    ["a longer", `passphrase=${TOKEN}x`],
    ["a repeated", `passphrase=${TOKEN}&passphrase=${TOKEN}`],
  ])("refuses %s passphrase with the form again", async (_label, body) => {
    const response = await postDiag(buildApp(), body);
    expect(response.status).toBe(401);
    expect(response.text).toContain("Wrong passphrase");
    expect(response.text).toContain('name="passphrase"');
    expect(response.text).not.toContain(TOKEN);
    expectNothingRan();
  });

  it.each([
    ["an array", [TOKEN]],
    ["an object", { value: TOKEN }],
    ["a number", 1],
  ])("refuses %s as a JSON passphrase", async (_label, passphrase) => {
    const response = await request(buildApp()).post("/diag").send({ passphrase });
    expect(response.status).toBe(401);
    expectNothingRan();
  });

  it("reads a JSON passphrase, so those refusals are about its type", async () => {
    const response = await request(buildApp()).post("/diag").send({ passphrase: TOKEN });
    expect(response.status).toBe(200);
  });

  it("never echoes what was typed", async () => {
    const typed = "typed-words<script>x()</script>";
    const response = await postDiag(buildApp(), { passphrase: typed, format: "json" });
    expect(response.status).toBe(401);
    expect(response.text).not.toContain("typed-words");
    expect(response.text).not.toContain("<script>");
  });

  it("no longer serves the report at the old address, even with the right token", async () => {
    const response = await request(buildApp()).get(`${OLD_HEALTH}?token=${TOKEN}`);
    expect(response.status).toBe(404);
    expect(response.text).not.toContain("Mike health");
    expect(response.text).not.toContain("the frontend shell");
    expectNothingRan();
  });

  it("serves the report for the right passphrase, with no session, whatever the Origin", async () => {
    const response = await postDiag(buildApp(), { passphrase: TOKEN }).set("Origin", "https://not-listed.example.test");
    expect(response.status).toBe(200);
    expect(response.type).toBe("text/html");
    expect(response.text).toContain("Mike health");
    expect(response.text).toContain("Broken.");
    expect(service.runHealthChecks).toHaveBeenCalledTimes(1);
  });

  it("returns the same results as JSON with a summary", async () => {
    const response = await postDiag(buildApp(), { passphrase: TOKEN, format: "json" });
    expect(response.status).toBe(200);
    expect(response.type).toBe("application/json");
    expect(response.body.summary).toEqual({ fail: 1, warn: 1, info: 0, skip: 0, pass: 1 });
    expect(response.body.checks).toEqual(checks);
    expect(typeof response.body.generatedAt).toBe("string");
  });

  it("shows failures first, then warnings, above the groups", async () => {
    const { text } = await postDiag(buildApp(), { passphrase: TOKEN });
    const summary = text.indexOf('class="summary"');
    const firstFail = text.indexOf("Broken.");
    const firstWarn = text.indexOf("Soon.");
    const firstPass = text.indexOf("Fine.");
    expect(summary).toBeGreaterThan(-1);
    expect(summary).toBeLessThan(firstFail);
    expect(firstFail).toBeLessThan(firstWarn);
    expect(firstWarn).toBeLessThan(firstPass);
    expect(text).toContain("1 fail, 1 warn, 0 info, 0 skip, 1 pass");
  });

  it("escapes everything a check returns", async () => {
    service.runHealthChecks.mockResolvedValue([{
      id: "<id>", group: "<group>", title: "<script>title()</script>", status: "warn",
      detail: `<img src=x onerror="detail()">`, remediation: "<b>'remedy'</b> & more",
    }]);
    const { text } = await postDiag(buildApp(), { passphrase: TOKEN });
    for (const raw of ["<script>title", "<img", "<b>", "<group>", "<id>"]) expect(text).not.toContain(raw);
    expect(text).toContain("&lt;script&gt;title()");
    expect(text).toContain("&#39;remedy&#39;");
  });

  it("forbids caching and referrers on the form", async () => {
    const response = await request(buildApp()).get("/diag");
    expect(response.status).toBe(200);
    expectHealthHeaders(response);
  });

  it.each([{}, { format: "json" }])("forbids caching and referrers, and never echoes the passphrase (%j)", async (fields) => {
    const response = await postDiag(buildApp(), { passphrase: TOKEN, ...fields });
    expect(response.status).toBe(200);
    expectHealthHeaders(response);
    expect(response.text).not.toContain(TOKEN);
  });

  it("sets the same headers on a refused passphrase", async () => {
    const response = await postDiag(buildApp(), { passphrase: "wrong" });
    expect(response.status).toBe(401);
    expectHealthHeaders(response);
  });

  it("sets the same headers when the general limiter or a body parser refuses first", async () => {
    vi.stubEnv("RATE_LIMIT_GENERAL_MAX", "1");
    const limited = buildApp();
    await request(limited).get("/diag");
    const tooMany = await request(limited).get("/diag");
    expect(tooMany.status).toBe(429);
    expectHealthHeaders(tooMany);

    vi.unstubAllEnvs();
    const tooLarge = await postDiag(buildApp(), { passphrase: "x".repeat(40_000) });
    expect(tooLarge.status).toBe(413);
    expectHealthHeaders(tooLarge);
  });

  it("still renders when the service itself fails, without its message", async () => {
    service.runHealthChecks.mockRejectedValue(new Error("raw secret text"));
    const response = await postDiag(buildApp(), { passphrase: TOKEN });
    expect(response.status).toBe(200);
    expect(response.text).toContain("The checks could not run.");
    expect(response.text).not.toContain("raw secret text");
  });

  describe("wrong-passphrase limit", () => {
    const LIMIT = 10;

    async function failTimes(server: express.Express, times: number): Promise<void> {
      for (let attempt = 0; attempt < times; attempt += 1) {
        const response = await postDiag(server, { passphrase: "wrong" });
        expect(response.status).toBe(401);
      }
    }

    it("locks out even the right passphrase, and says to wait", async () => {
      const server = buildApp();
      await failTimes(server, LIMIT);
      const response = await postDiag(server, { passphrase: TOKEN });
      expect(response.status).toBe(429);
      expect(response.type).toBe("text/html");
      expect(response.text).toMatch(/wait/i);
      expect(response.text).not.toContain(TOKEN);
      expectHealthHeaders(response);
      expectNothingRan();
    });

    it("is not per client address", async () => {
      const server = buildApp();
      for (let attempt = 0; attempt < LIMIT; attempt += 1) {
        const response = await postDiag(server, { passphrase: "wrong" }).set("X-Forwarded-For", `203.0.113.${attempt}`);
        expect(response.status).toBe(401);
      }
      const response = await postDiag(server, { passphrase: "wrong" }).set("X-Forwarded-For", "203.0.113.200");
      expect(response.status).toBe(429);
    });

    it("does not count successes", async () => {
      const server = buildApp();
      for (let attempt = 0; attempt < LIMIT + 2; attempt += 1) {
        expect((await postDiag(server, { passphrase: TOKEN })).status).toBe(200);
      }
      await failTimes(server, LIMIT);
      expect((await postDiag(server, { passphrase: TOKEN })).status).toBe(429);
    });

    it("does not count a right passphrase whose client disconnects during the report", async () => {
      const server = buildApp();
      const listening = http.createServer(server);
      await new Promise<void>((resolve) => { listening.listen(0, "127.0.0.1", resolve); });
      try {
        let reportStarted = (): void => undefined;
        const started = new Promise<void>((resolve) => { reportStarted = resolve; });
        let finishReport = (_results: unknown[]): void => undefined;
        service.runHealthChecks.mockImplementationOnce(() => {
          reportStarted();
          return new Promise<unknown[]>((resolve) => { finishReport = resolve; });
        });
        const disconnected = new Promise<void>((resolve) => {
          listening.once("connection", (socket) => { socket.once("close", () => { resolve(); }); });
        });
        const { port } = listening.address() as AddressInfo;
        const client = http.request({
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/diag",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        client.on("error", () => undefined);
        client.end(new URLSearchParams({ passphrase: TOKEN }).toString());

        await started;
        client.destroy();
        await disconnected;
        finishReport(checks);

        // The whole budget is still there, and then it is enforced as usual.
        await failTimes(server, LIMIT);
        expect((await postDiag(server, { passphrase: TOKEN })).status).toBe(429);
      } finally {
        await new Promise((resolve) => { listening.close(resolve); });
      }
    });

    it("shares one count between /diag and /diag/", async () => {
      const server = buildApp();
      for (let attempt = 0; attempt < LIMIT; attempt += 1) {
        const response = await request(server).post("/diag/").type("form").send({ passphrase: "wrong" });
        expect(response.status).toBe(401);
      }
      expect((await postDiag(server, { passphrase: TOKEN })).status).toBe(429);
      const slash = await request(server).post("/diag/").type("form").send({ passphrase: TOKEN });
      expect(slash.status).toBe(429);
      expectNothingRan();
    });

    it("leaves the form available during a lockout", async () => {
      const server = buildApp();
      await failTimes(server, LIMIT);
      expect((await request(server).get("/diag")).status).toBe(200);
    });

    it("does not carry a lockout into another app", async () => {
      await failTimes(buildApp(), LIMIT);
      expect((await postDiag(buildApp(), { passphrase: TOKEN })).status).toBe(200);
    });
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
