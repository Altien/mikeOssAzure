import { createPublicKey, createVerify } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import type { AuthValidationResult } from "../types.js";
import { getConfig } from "../../config.js";

interface JwtHeader {
  alg?: unknown;
  kid?: unknown;
}

interface EntraClaims {
  oid?: unknown;
  // Email-shaped claims.  v2.0 tokens use preferred_username; v1.0 tokens
  // typically use upn or unique_name instead.  email is an optional claim
  // in both versions and only present if added in the app registration.
  preferred_username?: unknown;
  email?: unknown;
  upn?: unknown;
  unique_name?: unknown;
  // Display-name claims.  `name` is a default claim in both v1.0 and v2.0
  // tokens for human users.  given_name / family_name require the optional
  // claims block in the app registration so they may be undefined.
  name?: unknown;
  given_name?: unknown;
  family_name?: unknown;
  tid?: unknown;
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  ver?: unknown;
  groups?: unknown;
  _claim_names?: unknown;
}

interface JwkKey {
  kid?: string;
  kty?: string;
  use?: string;
  n?: string;
  e?: string;
}

function b64urlToBuffer(input: string): Buffer {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function nowEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

const JWKS_TTL_MS = 5 * 60 * 1000;
let cache: { tenantId: string; fetchedAt: number; keys: JwkKey[] } | undefined;

async function getJwks(tenantId: string): Promise<JwkKey[]> {
  const now = Date.now();
  if (cache && cache.tenantId === tenantId && now - cache.fetchedAt < JWKS_TTL_MS) {
    return cache.keys;
  }

  const response = await fetch(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`);
  if (!response.ok) {
    throw new Error("Failed to fetch JWKS");
  }

  const body = (await response.json()) as { keys?: unknown };
  const keys = Array.isArray(body.keys) ? (body.keys as JwkKey[]) : [];
  cache = { tenantId, fetchedAt: now, keys };
  return keys;
}

function verifySignature(token: string, key: JsonWebKey): boolean {
  const [headerB64, payloadB64, sigB64] = token.split(".");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();

  const publicKey = createPublicKey({ key, format: "jwk" });
  return verifier.verify(publicKey, b64urlToBuffer(sigB64));
}

// One-shot diagnostic flag so the "Server auth is not configured" path
// emits a clear log line exactly once per process lifetime. Without this
// the operator sees opaque 401s with no signal pointing at the missing
// KV / env state — see 040 Entry 11.
let configMissingLogged = false;

export async function validateEntraToken(token: string): Promise<AuthValidationResult> {
  // getConfig() checks process.env first (uppercased, hyphens → underscores)
  // and falls back to KV via the install backend's UAMI. Managed deployments
  // can populate KV via create-entra-apps.ps1 or provisioning automation;
  // other deployments still work via ENTRA_TENANT_ID / ENTRA_BACKEND_CLIENT_ID
  // env vars. Single call site, both sources, no further plumbing required.
  // Closes 040 Entry 11.
  const tenantId = await getConfig("entra-tenant-id").catch(() => "");
  const backendClientId = await getConfig("entra-backend-client-id").catch(() => "");

  if (!tenantId || !backendClientId) {
    if (!configMissingLogged) {
      console.error(
        "auth.entra.config_missing",
        "Token validation cannot proceed — neither KV (entra-tenant-id / entra-backend-client-id) nor env (ENTRA_TENANT_ID / ENTRA_BACKEND_CLIENT_ID) provided values. Run create-entra-apps.ps1 from /install OR set the env vars on the Container App. This warning is logged once per process.",
      );
      configMissingLogged = true;
    }
    return { ok: false, status: 401, detail: "Server auth is not configured" };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, status: 401, detail: "Malformed JWT" };
  }

  let header: JwtHeader;
  let claims: EntraClaims;
  try {
    header = JSON.parse(b64urlToBuffer(parts[0]).toString("utf8"));
    claims = JSON.parse(b64urlToBuffer(parts[1]).toString("utf8"));
  } catch {
    return { ok: false, status: 401, detail: "Malformed JWT" };
  }

  if (header.alg !== "RS256") {
    return { ok: false, status: 401, detail: "Invalid token algorithm" };
  }

  const kid = asString(header.kid);
  if (!kid) {
    return { ok: false, status: 401, detail: "Missing token key id" };
  }

  try {
    const keys = await getJwks(tenantId);
    const jwk = keys.find((key) => key.kid === kid && key.kty === "RSA") as JsonWebKey | undefined;
    if (!jwk || !jwk.n || !jwk.e) {
      return { ok: false, status: 401, detail: "Invalid or expired token" };
    }

    if (!verifySignature(token, jwk)) {
      return { ok: false, status: 401, detail: "Invalid or expired token" };
    }
  } catch {
    return { ok: false, status: 401, detail: "Invalid or expired token" };
  }

  // Issuer check accepts both token versions.  Entra issues v1.0 tokens by
  // default unless the API app registration sets accessTokenAcceptedVersion: 2
  // in its manifest — forcing every customer to flip that switch is
  // unreasonable, so we accept either.
  //   v1.0: https://sts.windows.net/<tid>/
  //   v2.0: https://login.microsoftonline.com/<tid>/v2.0
  const v1Iss = `https://sts.windows.net/${tenantId}/`;
  const v2Iss = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  if (claims.iss !== v1Iss && claims.iss !== v2Iss) {
    return { ok: false, status: 401, detail: "Invalid issuer" };
  }

  // Audience check accepts both shapes.  v2.0 tokens use the bare client ID
  // GUID; v1.0 tokens use `api://<guid>` (the application ID URI).  Both
  // identify the same application — the customer's manifest decides which
  // form lands in the token.
  const validAudiences = new Set<string>([
    backendClientId,
    `api://${backendClientId}`,
  ]);
  if (typeof claims.aud !== "string" || !validAudiences.has(claims.aud)) {
    return { ok: false, status: 401, detail: "Invalid audience" };
  }

  if (claims.tid !== tenantId) {
    return { ok: false, status: 401, detail: "Invalid tenant" };
  }

  const exp = typeof claims.exp === "number" ? claims.exp : undefined;
  if (!exp) {
    return { ok: false, status: 401, detail: "Token missing exp claim" };
  }
  if (exp <= nowEpochSeconds()) {
    return { ok: false, status: 401, detail: "Token expired" };
  }

  const nbf = typeof claims.nbf === "number" ? claims.nbf : undefined;
  if (nbf && nbf > nowEpochSeconds()) {
    return { ok: false, status: 401, detail: "Token is not yet valid" };
  }

  const userId = asString(claims.oid);
  if (!userId) {
    return { ok: false, status: 401, detail: "Token missing oid claim" };
  }

  const overage = typeof claims._claim_names === "object" && claims._claim_names !== null && "groups" in claims._claim_names;
  if (overage) {
    console.warn("auth.entra.groups_overage", { provider: "entra", userId });
  }

  // Email-claim fallback chain covers both v2.0 (preferred_username) and
  // v1.0 (upn / unique_name) tokens.  email is optional in both and only
  // present if added to the app registration's optional claims.
  const email =
    asString(claims.preferred_username) ??
    asString(claims.email) ??
    asString(claims.upn) ??
    asString(claims.unique_name) ??
    "";
  if (!email) {
    console.warn("auth.entra.email_missing", { provider: "entra", userId });
  }

  // Resolve a display name from the token.  `name` is the canonical default
  // claim; if the directory entry has been kept clean it's just "First Last".
  // We fall back to assembling given+family ourselves (only present when the
  // app registration adds them as optional claims), then to the UPN-shaped
  // preferred_username as a last resort so the row never gets a blank
  // display name on first login when at least one identifying field exists.
  const nameClaim = asString(claims.name)?.trim();
  const givenName = asString(claims.given_name)?.trim();
  const familyName = asString(claims.family_name)?.trim();
  const assembledName = [givenName, familyName].filter(Boolean).join(" ");
  const displayName =
    nameClaim ||
    (assembledName.length > 0 ? assembledName : undefined) ||
    asString(claims.preferred_username)?.trim() ||
    undefined;

  return {
    ok: true,
    principal: {
      userId,
      email: email.toLowerCase(),
      displayName,
      tenantId,
      groups: overage ? [] : asStringArray(claims.groups),
      roles: [],
      provider: "entra",
    },
  };
}
