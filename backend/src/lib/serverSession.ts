import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { createServerSupabase } from "./supabase";
import { getKeyVaultConfig } from "./config";
import { requestOriginIsWordAddin } from "./origins";

const SESSION_NAME = "mike-session";
const SESSION_DAYS = 30;
const MAX_HANDOFF_SECONDS = 300;
let lastCleanupAt = 0;
type Provider = "entra" | "local" | "supabase";

export interface ServerCredential {
  provider: Provider;
  userId: string;
  accessToken: string;
  refreshToken?: string;
}

interface SessionRow {
  session_hash: string;
  provider: Provider;
  user_id: string;
  credential_cipher: string;
  token_expires_at: string;
  expires_at: string;
  version: number;
  revoked_at: string | null;
}

let sessionKey: Buffer | null = null;
let handoffKey: Buffer | null = null;
let stateKey: Buffer | null = null;

function decodeKey(value: string, name: string): Buffer {
  if (!value || value === "__unset__" || /replace|placeholder|change-me/i.test(value)) {
    throw new Error(`${name} is not configured`);
  }
  const decoded = Buffer.from(value, "base64url");
  // Existing installations may have the old Bicep GUID state secret. Keep
  // that value stable across rollout and derive a fixed HMAC key from it.
  if (name === "auth-state-secret" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) {
    return createHash("sha256").update(`mike-auth-state-v1:${value}`).digest();
  }
  if (decoded.length !== 32 || decoded.toString("base64url") !== value.replace(/=+$/, "")) {
    throw new Error(`${name} must be 32 random bytes in base64url form`);
  }
  return decoded;
}

async function loadKey(name: string, envName: string): Promise<Buffer> {
  let value = "";
  if (process.env.KEY_VAULT_NAME) {
    try { value = await getKeyVaultConfig(name); }
    catch (error) {
      if (!process.env[envName]) throw error;
    }
  }
  return decodeKey(value || process.env[envName] || "", name);
}

/** Required before listen: never mint a per-process fallback encryption key. */
export async function initServerSessionKeys(): Promise<void> {
  const [session, handoff, state] = await Promise.all([
    loadKey("auth-session-encryption-secret", "AUTH_SESSION_ENCRYPTION_SECRET"),
    loadKey("auth-handoff-encryption-secret", "AUTH_HANDOFF_ENCRYPTION_SECRET"),
    loadKey("auth-state-secret", "AUTH_STATE_SECRET"),
  ]);
  if (session.equals(handoff) || session.equals(state) || handoff.equals(state)) throw new Error("Auth keys must be distinct");
  sessionKey = session;
  handoffKey = handoff;
  stateKey = state;
  // Schema readiness is also required before accepting any cookie traffic.
  const { error } = await createServerSupabase().from("auth_sessions").select("session_hash").limit(1);
  if (error) throw new Error("Auth session schema is unavailable");
}

function key(kind: "session" | "handoff"): Buffer {
  const value = kind === "session" ? sessionKey : handoffKey;
  if (!value) throw new Error("Auth session keys have not been initialized");
  return value;
}

function seal(value: unknown, kind: "session" | "handoff", aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(kind), iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

function open<T>(encoded: string, kind: "session" | "handoff", aad: string): T {
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length < 29) throw new Error("Invalid credential ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key(kind), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  decipher.setAAD(Buffer.from(aad));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")) as T;
}

export function hashAuthToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function scheduleExpiredAuthCleanup(): void {
  const now = Date.now();
  if (now - lastCleanupAt < 5 * 60_000) return;
  lastCleanupAt = now;
  const db = createServerSupabase();
  const cutoff = new Date(now).toISOString();
  void Promise.all([
    db.from("auth_sessions").delete().lt("expires_at", cutoff),
    db.from("auth_handoff_tickets").delete().lt("expires_at", cutoff),
    db.from("auth_oauth_states").delete().lt("expires_at", cutoff),
  ]).then(results => { if (results.some(result => result.error)) lastCleanupAt = 0; })
    .catch(() => { lastCleanupAt = 0; });
}

function hashOAuthToken(value: string): string {
  if (!stateKey) throw new Error("Auth state key has not been initialized");
  return createHmac("sha256", stateKey).update(value).digest("hex");
}

function cookieName(): string {
  return process.env.NODE_ENV === "production" ? `__Host-${SESSION_NAME}` : SESSION_NAME;
}

function cookieOptions(req: Request) {
  const word = requestOriginIsWordAddin(req.get("origin"));
  return {
    httpOnly: true,
    secure: word || process.env.NODE_ENV === "production",
    sameSite: (word ? "none" : "lax") as "none" | "lax",
    path: "/",
    partitioned: word,
  };
}

export function setServerSessionCookie(req: Request, res: Response, raw: string): void {
  res.cookie(cookieName(), raw, { ...cookieOptions(req), maxAge: SESSION_DAYS * 86400_000 });
  res.setHeader("Cache-Control", "private, no-store");
}

export function clearServerSessionCookie(req: Request, res: Response): void {
  res.clearCookie(cookieName(), cookieOptions(req));
  res.setHeader("Cache-Control", "private, no-store");
}

export function sessionCookie(req: Request): string | null {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[cookieName()];
  return typeof value === "string" && /^[A-Za-z0-9_-]{40,128}$/.test(value) ? value : null;
}

export async function createServerSession(req: Request, res: Response, credential: ServerCredential, tokenExpiresAt: Date): Promise<void> {
  const raw = randomBytes(32).toString("base64url");
  const hash = hashAuthToken(raw);
  const cipher = seal(credential, "session", `${credential.provider}:${credential.userId}:${hash}`);
  const { error } = await createServerSupabase().from("auth_sessions").insert({
    session_hash: hash,
    provider: credential.provider,
    user_id: credential.userId,
    credential_cipher: cipher,
    token_expires_at: tokenExpiresAt.toISOString(),
    expires_at: new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString(),
  });
  if (error) throw new Error("Unable to create auth session");
  scheduleExpiredAuthCleanup();
  setServerSessionCookie(req, res, raw);
}

export async function replaceServerSession(req: Request, res: Response, credential: ServerCredential, tokenExpiresAt: Date): Promise<void> {
  await revokeServerSession(req);
  await createServerSession(req, res, credential, tokenExpiresAt);
}

export async function readServerSession(req: Request): Promise<{ row: SessionRow; credential: ServerCredential } | null> {
  const raw = sessionCookie(req);
  if (!raw) return null;
  const hash = hashAuthToken(raw);
  const { data, error } = await createServerSupabase().from("auth_sessions")
    .select("session_hash,provider,user_id,credential_cipher,token_expires_at,expires_at,version,revoked_at")
    .eq("session_hash", hash).maybeSingle();
  if (error) throw new Error("Unable to read auth session");
  const row = data as SessionRow | null;
  if (!row || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) return null;
  const credential = open<ServerCredential>(row.credential_cipher, "session", `${row.provider}:${row.user_id}:${hash}`);
  if (credential.provider !== row.provider || credential.userId !== row.user_id) throw new Error("Auth session identity mismatch");
  return { row, credential };
}

export async function revokeServerSession(req: Request): Promise<void> {
  const raw = sessionCookie(req);
  if (!raw) return;
  const { error } = await createServerSupabase().rpc("revoke_auth_session", { p_session_hash: hashAuthToken(raw) });
  if (error) throw new Error("Unable to revoke auth session");
}

export async function refreshServerSession(
  current: { row: SessionRow; credential: ServerCredential },
  renew: (refreshToken: string) => Promise<{ accessToken: string; refreshToken?: string; expiresAt: Date }>,
): Promise<boolean> {
  const { row, credential } = current;
  if (!credential.refreshToken) return false;
  const owner = randomUUID();
  const db = createServerSupabase();
  const claim = await db.rpc("claim_auth_session_refresh", {
    p_session_hash: row.session_hash, p_version: row.version, p_owner: owner, p_lease_seconds: 45,
  });
  if (claim.error || claim.data !== true) return false;
  const renewed = await renew(credential.refreshToken);
  const next: ServerCredential = {
    ...credential,
    accessToken: renewed.accessToken,
    refreshToken: renewed.refreshToken || credential.refreshToken,
  };
  const finished = await db.rpc("finish_auth_session_refresh", {
    p_session_hash: row.session_hash,
    p_version: row.version,
    p_owner: owner,
    p_credential_cipher: seal(next, "session", `${row.provider}:${row.user_id}:${row.session_hash}`),
    p_token_expires_at: renewed.expiresAt.toISOString(),
  });
  return !finished.error && finished.data === true;
}

export async function createAuthHandoff(credential: ServerCredential, targetOrigin: string, requestId: string, ttlSeconds = 120): Promise<string> {
  if (!requestId || requestId.length > 128 || ttlSeconds < 30 || ttlSeconds > MAX_HANDOFF_SECONDS) throw new Error("Invalid handoff request");
  const ticket = randomBytes(32).toString("base64url");
  const hash = hashAuthToken(ticket);
  const { error } = await createServerSupabase().from("auth_handoff_tickets").insert({
    ticket_hash: hash,
    provider: credential.provider,
    user_id: credential.userId,
    credential_cipher: seal(credential, "handoff", `${targetOrigin}:${requestId}:${hash}`),
    target_origin: targetOrigin,
    request_id: requestId,
    expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  });
  if (error) throw new Error("Unable to create auth handoff");
  scheduleExpiredAuthCleanup();
  return ticket;
}

export async function consumeAuthHandoff(ticket: string, targetOrigin: string, requestId: string): Promise<ServerCredential | null> {
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(ticket)) return null;
  const hash = hashAuthToken(ticket);
  const { data, error } = await createServerSupabase().rpc("consume_auth_handoff", {
    p_ticket_hash: hash, p_target_origin: targetOrigin, p_request_id: requestId,
  });
  if (error) throw new Error("Unable to consume auth handoff");
  const row = (data as { provider: Provider; user_id: string; credential_cipher: string }[] | null)?.[0];
  if (!row) return null;
  const credential = open<ServerCredential>(row.credential_cipher, "handoff", `${targetOrigin}:${requestId}:${hash}`);
  if (credential.provider !== row.provider || credential.userId !== row.user_id) throw new Error("Auth handoff identity mismatch");
  return credential;
}

export async function createOAuthState(input: {
  provider: string;
  browserNonce: string;
  codeVerifier: string;
  returnUrl: string;
  targetOrigin: string;
  requestId?: string;
}, stateToken?: string): Promise<string> {
  const state = stateToken ?? randomBytes(32).toString("base64url");
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(state)) throw new Error("Invalid OAuth state token");
  const hash = hashOAuthToken(state);
  const { error } = await createServerSupabase().from("auth_oauth_states").insert({
    state_hash: hash,
    provider: input.provider,
    browser_nonce_hash: hashOAuthToken(input.browserNonce),
    code_verifier_cipher: seal(input.codeVerifier, "handoff", `${input.targetOrigin}:${hash}`),
    return_url: input.returnUrl,
    target_origin: input.targetOrigin,
    request_id: input.requestId ?? null,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  if (error) throw new Error("Unable to create OAuth state");
  scheduleExpiredAuthCleanup();
  return state;
}

export async function consumeOAuthState(state: string, browserNonce: string): Promise<{
  provider: string;
  codeVerifier: string;
  returnUrl: string;
  targetOrigin: string;
  requestId: string | null;
} | null> {
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(state) || !/^[A-Za-z0-9_-]{40,128}$/.test(browserNonce)) return null;
  const hash = hashOAuthToken(state);
  const { data, error } = await createServerSupabase().rpc("consume_auth_oauth_state", {
    p_state_hash: hash,
    p_browser_nonce_hash: hashOAuthToken(browserNonce),
  });
  if (error) throw new Error("Unable to consume OAuth state");
  const row = (data as {
    provider: string; code_verifier_cipher: string; return_url: string;
    target_origin: string; request_id: string | null;
  }[] | null)?.[0];
  if (!row) return null;
  return {
    provider: row.provider,
    codeVerifier: open<string>(row.code_verifier_cipher, "handoff", `${row.target_origin}:${hash}`),
    returnUrl: row.return_url,
    targetOrigin: row.target_origin,
    requestId: row.request_id,
  };
}
