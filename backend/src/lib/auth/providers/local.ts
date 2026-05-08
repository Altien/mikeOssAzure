import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthValidationResult } from "../types.js";

// HS256 verification with stdlib only — no new dependency.

interface LocalClaims {
  sub?: unknown;
  exp?: unknown;
  email?: unknown;
  role?: unknown;
  tid?: unknown;
  groups?: unknown;
  roles?: unknown;
}

function b64urlDecode(input: string): Buffer {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export async function validateLocalToken(
  token: string,
): Promise<AuthValidationResult> {
  const secret = process.env.JWT_SECRET ?? "";
  if (!secret) {
    return { ok: false, status: 401, detail: "Server auth is not configured" };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, status: 401, detail: "Malformed JWT" };
  }
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(b64urlDecode(headerB64).toString("utf8"));
  } catch {
    return { ok: false, status: 401, detail: "Malformed JWT header" };
  }
  if (header.alg !== "HS256") {
    return { ok: false, status: 401, detail: `Unsupported alg: ${header.alg}` };
  }

  const expected = createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const actual = b64urlDecode(sigB64);
  if (
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  ) {
    return { ok: false, status: 401, detail: "Invalid signature" };
  }

  let claims: LocalClaims;
  try {
    claims = JSON.parse(b64urlDecode(payloadB64).toString("utf8"));
  } catch {
    return { ok: false, status: 401, detail: "Malformed JWT payload" };
  }

  const sub = asString(claims.sub);
  if (!sub) {
    return { ok: false, status: 401, detail: "Token missing sub claim" };
  }

  const exp = typeof claims.exp === "number" ? claims.exp : 0;
  if (!exp) {
    return { ok: false, status: 401, detail: "Token missing exp claim" };
  }
  if (exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, status: 401, detail: "Token expired" };
  }

  return {
    ok: true,
    principal: {
      userId: sub,
      email: asString(claims.email)?.toLowerCase() ?? "",
      tenantId: asString(claims.tid),
      groups: asStringArray(claims.groups),
      roles: asStringArray(claims.roles),
      provider: "local",
    },
  };
}
