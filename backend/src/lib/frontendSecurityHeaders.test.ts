import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { frontendSecurityHeaders, sendFrontendSecurityHeaders } from "./frontendSecurityHeaders";

// The web app's table (upstream 84805159). The backend cannot import the
// frontend tree in its build, but vitest can load it here, so the copy the
// static-frontend block sends cannot drift from it.
const WEB_APP_TABLE = pathToFileURL(
  resolve(__dirname, "../../../frontend/src/app/lib/securityHeaders.ts"),
).href;

describe("static web app security headers", () => {
  it.each([true, false])("match the web app's securityHeaders(production=%s)", async (production) => {
    const { securityHeaders } = (await import(WEB_APP_TABLE)) as {
      securityHeaders: (production: boolean) => unknown;
    };
    expect(frontendSecurityHeaders(production)).toEqual(securityHeaders(production));
  });
});

describe("sendFrontendSecurityHeaders", () => {
  function run(path: string): Record<string, string> {
    const set: Record<string, string> = {};
    const res = { setHeader: (key: string, value: string) => { set[key] = value; } };
    sendFrontendSecurityHeaders(true)({ path } as never, res as never, () => {});
    return set;
  }

  it("sends the web-app headers on pages and assets", () => {
    expect(run("/projects/_")["X-Frame-Options"]).toBe("DENY");
    expect(run("/apiary")["X-Frame-Options"]).toBe("DENY");
  });

  it("leaves /api responses with the backend's own helmet headers", () => {
    expect(run("/api")).toEqual({});
    expect(run("/api/unknown")).toEqual({});
  });
});
