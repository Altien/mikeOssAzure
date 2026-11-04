// The PostgREST diagnostics must sign their raw calls: entra PostgREST has no
// anonymous role, so an unsigned GET reports a failure that is not real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPostgrestJwtState } from "../../lib/supabase";
import { resetTenantConfigCache } from "../../lib/tenantContext";
import { runDiagnostics } from "./platform.service";

const SECRET = "a-test-postgrest-secret-of-at-least-32-chars";
const TOUCHED_ENV = [
  "AUTH_PROVIDER",
  "SUPABASE_URL",
  "POSTGREST_JWT_SECRET",
  "KEY_VAULT_NAME",
  "ENTRA_TENANT_ID",
] as const;
const saved: Record<string, string | undefined> = {};

type Captured = { url: string; authorization: string | null };
let captured: Captured[] = [];

beforeEach(() => {
  for (const key of TOUCHED_ENV) saved[key] = process.env[key];
  delete process.env.KEY_VAULT_NAME;
  process.env.AUTH_PROVIDER = "entra";
  process.env.POSTGREST_JWT_SECRET = SECRET;
  process.env.ENTRA_TENANT_ID = "install-tid";
  process.env.SUPABASE_URL = `http://${crypto.randomUUID()}.postgrest.test`;
  resetPostgrestJwtState();
  resetTenantConfigCache();
  captured = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    captured.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of TOUCHED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function decodedClaims(authorization: string): Record<string, unknown> {
  const payload = authorization.replace(/^Bearer /, "").split(".")[1];
  return JSON.parse(Buffer.from(payload, "base64url").toString());
}

describe("runDiagnostics in entra mode", () => {
  it("signs every PostgREST call as the install's tenant", async () => {
    await runDiagnostics();

    expect(captured.length).toBeGreaterThan(5);
    const unsigned = captured.filter((call) => !call.authorization);
    expect(unsigned.map((call) => call.url)).toEqual([]);
    expect(decodedClaims(captured[0].authorization ?? "")).toMatchObject({
      role: "tenant_app",
      tenant_id: "install-tid",
    });
  });
});
