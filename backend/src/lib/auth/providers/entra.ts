import { createPublicKey, createVerify } from "node:crypto";
import type { AuthValidationResult } from "../types.js";
import { getConfig } from "../../config.js";
import { getTenancyMode } from "../../tenancyMode";
import { externalIdentityConfiguration, externalIdentityConfigured, type EntraIdentityKind } from "../entraConfiguration";

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
  roles?: unknown;
  _claim_names?: unknown;
}

interface JwkKey {
  kid?: string;
  kty?: string;
  use?: string;
  n?: string;
  e?: string;
  issuer?: string;
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
const cache = new Map<string, { fetchedAt: number; keys: JwkKey[] }>();

// Keyed by key-set URI: every pooled Microsoft directory shares the one
// `common` key set, so an arbitrary token `tid` never causes a fetch.
async function getJwks(jwksUri: string): Promise<JwkKey[]> {
  const now = Date.now();
  const cached = cache.get(jwksUri);
  if (cached && now - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;

  const response = await fetch(jwksUri, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error("Failed to fetch JWKS");
  }

  const body = (await response.json()) as { keys?: unknown };
  const keys = Array.isArray(body.keys) ? (body.keys as JwkKey[]) : [];
  if (cache.size >= 100) cache.delete(cache.keys().next().value!);
  cache.set(jwksUri, { fetchedAt: now, keys });
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
  let pooled: boolean;
  try { pooled = await getTenancyMode() === "pooled"; }
  catch { return { ok: false, status: 401, detail: "Server auth is not configured" }; }
  let tenantId = await getConfig("entra-tenant-id").catch(() => "");
  let backendClientId = await getConfig("entra-backend-client-id").catch(() => "");

  if (!pooled && (!tenantId || !backendClientId)) {
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

  let identityKind: EntraIdentityKind | undefined;
  let issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  let jwksUri = `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`;
  if (pooled) {
    try {
      const external = await externalIdentityConfigured() ? await externalIdentityConfiguration() : undefined;
      const tid = asString(claims.tid);
      if (external && tid === external.tenantId) {
        if (claims.iss !== external.issuer) return { ok: false, status: 401, detail: "Invalid issuer" };
        identityKind = "altien";
        tenantId = external.tenantId;
        backendClientId = external.backendId;
        issuer = external.issuer;
        jwksUri = external.jwksUri;
      } else {
        if (!tid || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(tid)) return { ok: false, status: 401, detail: "Invalid tenant" };
        issuer = `https://login.microsoftonline.com/${tid}/v2.0`;
        if (claims.iss !== issuer) return { ok: false, status: 401, detail: "Invalid issuer" };
        // Work and personal (consumers tenant) accounts alike. Admission is
        // decided after validation: a named member, else a linked directory,
        // else onboarding (tenantContext.resolveTenant / tenantAccess).
        if (!backendClientId) return { ok: false, status: 401, detail: "Server auth is not configured" };
        identityKind = "enterprise";
        tenantId = tid;
        // One shared key set; each key's issuer template is checked against this tid below.
        jwksUri = "https://login.microsoftonline.com/common/discovery/v2.0/keys";
      }
    } catch { return { ok: false, status: 401, detail: "Server auth is not configured" }; }
  }

  try {
    const keys = await getJwks(jwksUri);
    const jwk = keys.find((key) => key.kid === kid && key.kty === "RSA") as JsonWebKey | undefined;
    const keyIssuer = (jwk as JwkKey | undefined)?.issuer?.replace("{tenantid}", tenantId);
    if (!jwk || !jwk.n || !jwk.e || (pooled && keyIssuer && keyIssuer !== issuer)) {
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
  if (!pooled && claims.iss !== v1Iss && claims.iss !== v2Iss) {
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
      tenantId: pooled ? undefined : tenantId,
      directoryId: tenantId,
      ...(identityKind ? { identityKind } : {}),
      appRoles: asStringArray(claims.roles),
      groups: overage ? [] : asStringArray(claims.groups),
      roles: [],
      provider: "entra",
    },
  };
}
