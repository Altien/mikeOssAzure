import { createHash, createHmac, randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { getConfig } from "../lib/config";
import { validateEntraToken } from "../lib/auth/providers/entra";
import { validateLocalToken } from "../lib/auth/providers/local";
import { validateSupabaseToken } from "../lib/auth/providers/supabase";
import { requestOriginIsTrusted, requestOriginIsWordAddin } from "../lib/origins";
import {
  clearServerSessionCookie, consumeAuthHandoff, consumeOAuthState,
  createAuthHandoff, createOAuthState, createServerSession,
  revokeServerSession, replaceServerSession, type ServerCredential,
} from "../lib/serverSession";
import { requireAuth } from "../middleware/auth";
import { tenantAccess } from "../middleware/tenantAccess";
import { requireTrustedOrigin } from "../middleware/trustedOrigin";
import { upsertUserProfile } from "../lib/userSettings";
import {
  createSupabaseAuthClient, exchangeSupabaseOAuth, publicSupabaseUser,
  startSupabaseOAuth, startSupabaseRecovery, supabaseCredential, supabaseExpiresAt, createCredentialClient,
} from "../lib/auth/providers/supabaseSession";
import { readServerSession } from "../lib/serverSession";

export const authRouter = Router();
authRouter.use(requireTrustedOrigin);
const OAUTH_NONCE_COOKIE = "mike-oauth-browser";

async function authProvider(): Promise<string> {
  return (await getConfig("auth-provider").catch(() => process.env.AUTH_PROVIDER || "supabase")) || "supabase";
}

function frontendOrigin(): URL { return new URL(process.env.FRONTEND_URL || "http://localhost:3000"); }

async function backendPublicOrigin(req: Request): Promise<string> {
  const configured = process.env.API_PUBLIC_URL || await getConfig("backend-public-url").catch(() => "");
  if (configured) {
    const parsed = new URL(configured);
    if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") throw new Error("Backend public URL must use HTTPS");
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("Backend public URL must be an origin");
    return parsed.origin;
  }
  if (process.env.NODE_ENV === "production") throw new Error("Backend public URL is required");
  return new URL(`${req.protocol}://${req.get("host")}`).origin;
}

function safeReturnUrl(raw: unknown): string {
  const base = frontendOrigin();
  const fallback = new URL("/assistant", base).toString();
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  try {
    const value = new URL(raw, base);
    return value.origin === base.origin ? value.toString() : fallback;
  } catch { return fallback; }
}

async function entraConfiguration(req: Request, word = false) {
  const [tenantId, clientId, clientSecret, backendId, publicUrl] = await Promise.all([
    getConfig("entra-tenant-id"), getConfig("entra-client-id"),
    getConfig("entra-client-secret"), getConfig("entra-backend-client-id"),
    getConfig("backend-public-url").catch(() => ""),
  ]);
  if (!tenantId || !clientId || !backendId) throw new Error("Entra OpenID configuration is unavailable");
  return {
    tenantId, clientId, clientSecret,
    scopes: process.env.ENTRA_AUTH_SCOPES || `openid profile email offline_access api://${backendId}/access_as_user`,
    redirectUri: word
      ? `${(process.env.WORD_ADDIN_URL || (process.env.NODE_ENV === "production" ? "" : "https://localhost:3200")).replace(/\/+$/, "")}/api/auth/openid-callback/microsoft`
      : process.env.ENTRA_REDIRECT_URI || `${publicUrl.replace(/\/+$/, "") || `${req.protocol}://${req.get("host")}`}/api/auth/openid-callback/microsoft`,
  };
}

export function buildEntraTokenForm(
  creds: { clientId: string; clientSecret?: string; scopes: string },
  grant: { grant_type: "authorization_code"; code: string; redirect_uri: string; code_verifier?: string }
    | { grant_type: "refresh_token"; refresh_token: string },
): URLSearchParams {
  const form = new URLSearchParams({ client_id: creds.clientId, scope: creds.scopes, ...grant });
  if (creds.clientSecret) form.set("client_secret", creds.clientSecret);
  return form;
}

async function exchangeEntraCode(req: Request, code: string, verifier: string, word = false) {
  const cfg = await entraConfiguration(req, word);
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: buildEntraTokenForm({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, scopes: cfg.scopes }, {
      grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri, code_verifier: verifier,
    }), signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!response.ok || !body.access_token || !Number.isFinite(body.expires_in)) throw new Error("Entra token exchange failed");
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresIn: body.expires_in! };
}

function tokenExpiresAt(token: string): Date {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { exp?: unknown };
    if (typeof claims.exp === "number" && claims.exp * 1000 > Date.now()) return new Date(claims.exp * 1000);
  } catch { /* Credential was validated before this call. */ }
  return new Date(Date.now() + 5 * 60_000);
}

async function admit(req: Request, res: Response, credential: ServerCredential): Promise<boolean> {
  const result = credential.provider === "entra"
    ? await validateEntraToken(credential.accessToken)
    : credential.provider === "local"
      ? await validateLocalToken(credential.accessToken)
      : await validateSupabaseToken(credential.accessToken);
  if (!result.ok || result.principal.userId !== credential.userId) {
    res.status(401).json({ detail: "Invalid authentication credential" }); return false;
  }
  res.locals.principal = result.principal;
  res.locals.userId = result.principal.userId;
  res.locals.userEmail = result.principal.email;
  let allowed = false;
  await tenantAccess(req, res, () => { allowed = true; });
  if (!allowed) return false;
  await upsertUserProfile(result.principal.userId, result.principal.email, result.principal.displayName);
  return true;
}

function publicUser(res: Response) {
  const principal = res.locals.principal as { userId: string; email: string };
  return { id: principal.userId, email: principal.email, pendingEmail: null, createdWithGoogle: false };
}

function trusted(req: Request, res: Response): boolean {
  if (requestOriginIsTrusted(req.get("origin"))) return true;
  res.status(403).json({ code: "untrusted_origin", detail: "The request origin is not allowed." });
  return false;
}

authRouter.get("/providers", async (_req, res) => {
  const provider = await authProvider();
  res.json({ defaultProvider: provider === "entra" ? "microsoft" : provider, providers: [
    { id: "microsoft", name: "Microsoft", mode: "openid", enabled: provider === "entra" },
  ] });
});

authRouter.get("/select-provider", async (req, res) => {
  if ((await authProvider()) !== "entra") { res.status(404).end(); return; }
  const query = new URLSearchParams({ returnUrl: safeReturnUrl(req.query.returnUrl) });
  if (req.query.selectAccount === "true") query.set("selectAccount", "true");
  res.redirect(`/api/auth/login-provider/microsoft?${query}`);
});

authRouter.get("/login-provider/:providerId", async (req, res) => {
  if (req.params.providerId !== "microsoft" || (await authProvider()) !== "entra") {
    res.status(404).json({ detail: "Microsoft login is unavailable" }); return;
  }
  try {
    const requestId = typeof req.query.requestId === "string" ? req.query.requestId : "";
    const wordOrigin = typeof req.query.wordOrigin === "string" ? req.query.wordOrigin : "";
    const word = !!requestId || !!wordOrigin;
    if (word && (!/^[A-Za-z0-9_-]{16,128}$/.test(requestId) || !requestOriginIsWordAddin(wordOrigin))) {
      res.status(400).json({ detail: "Invalid Word login request" }); return;
    }
    const cfg = await entraConfiguration(req, word);
    if (word && process.env.NODE_ENV === "production" && !process.env.WORD_ADDIN_URL) throw new Error("Word redirect is not configured");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const state = await createOAuthState({
      provider: "microsoft", browserNonce: nonce, codeVerifier: verifier,
      returnUrl: safeReturnUrl(req.query.returnUrl),
      targetOrigin: word ? wordOrigin : frontendOrigin().origin,
      ...(word ? { requestId } : {}),
    });
    res.cookie(OAUTH_NONCE_COOKIE, nonce, {
      httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax",
      path: "/api/auth", maxAge: 10 * 60_000,
    });
    res.setHeader("Cache-Control", "private, no-store");
    const authorize = new URL(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/authorize`);
    for (const [name, value] of Object.entries({
      client_id: cfg.clientId, response_type: "code", response_mode: "query",
      redirect_uri: cfg.redirectUri, scope: cfg.scopes, state,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    })) authorize.searchParams.set(name, value);
    if (req.query.selectAccount === "true") authorize.searchParams.set("prompt", "select_account");
    res.redirect(authorize.toString());
  } catch { res.status(503).json({ detail: "Microsoft login is unavailable" }); }
});

authRouter.get("/openid-callback/:providerId", async (req, res) => {
  if (req.params.providerId !== "microsoft" || (await authProvider()) !== "entra") { res.status(404).end(); return; }
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const nonce = req.cookies?.[OAUTH_NONCE_COOKIE];
  res.clearCookie(OAUTH_NONCE_COOKIE, { path: "/api/auth", sameSite: "lax", secure: process.env.NODE_ENV === "production" });
  res.setHeader("Cache-Control", "private, no-store");
  if (!code || typeof nonce !== "string") { res.status(400).json({ detail: "Invalid OpenID callback" }); return; }
  try {
    const state = await consumeOAuthState(typeof req.query.state === "string" ? req.query.state : "", nonce);
    if (!state || state.provider !== "microsoft") { res.status(400).json({ detail: "Invalid or expired OpenID state" }); return; }
    const tokens = await exchangeEntraCode(req, code, state.codeVerifier, !!state.requestId);
    const result = await validateEntraToken(tokens.accessToken);
    if (!result.ok) { res.status(401).json({ detail: "Microsoft identity validation failed" }); return; }
    const credential: ServerCredential = {
      provider: "entra", userId: result.principal.userId, accessToken: tokens.accessToken,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    };
    if (!(await admit(req, res, credential))) return;
    if (state.requestId) {
      if (!requestOriginIsWordAddin(state.targetOrigin)) { res.status(400).end(); return; }
      const ticket = await createAuthHandoff(credential, state.targetOrigin, state.requestId);
      const message = JSON.stringify({ type: "mike-word-handoff", requestId: state.requestId, status: "success", handoffTicket: ticket }).replace(/</g, "\\u003c");
      res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Mike sign-in</title><p>Completing Word sign-in…</p><script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js"></script><script>Office.onReady(() => Office.context.ui.messageParent(${message}, { targetOrigin: ${JSON.stringify(state.targetOrigin)} }));</script>`);
      return;
    }
    await createServerSession(req, res, credential, new Date(Date.now() + tokens.expiresIn * 1000));
    res.redirect(state.returnUrl);
  } catch { res.status(503).json({ detail: "Unable to complete Microsoft login" }); }
});

function localUserId(email: string): string {
  const hex = createHash("sha256").update(email).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function mintLocalToken(secret: string, email: string): { token: string; userId: string } {
  const userId = localUserId(email);
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ role: "authenticated", sub: userId, email, iat: now, exp: now + 8 * 3600 })).toString("base64url");
  const body = `${header}.${payload}`;
  return { token: `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`, userId };
}

authRouter.post("/local-login", async (req, res) => {
  if (!trusted(req, res)) return;
  if ((await authProvider()) !== "local") { res.status(404).end(); return; }
  const secret = process.env.JWT_SECRET || "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!secret || !email) { res.status(400).json({ detail: "Local login is unavailable" }); return; }
  try {
    const { token, userId } = mintLocalToken(secret, email);
    const credential: ServerCredential = { provider: "local", userId, accessToken: token };
    if (!(await admit(req, res, credential))) return;
    await createServerSession(req, res, credential, tokenExpiresAt(token));
    res.json({ user: publicUser(res) });
  } catch { res.status(503).json({ detail: "Local login is unavailable" }); }
});

authRouter.get("/session", requireAuth, async (_req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  if (res.locals.principal?.provider === "supabase") {
    try {
      const { data, error } = await createSupabaseAuthClient().auth.getUser(res.locals.token as string);
      if (error || !data.user || data.user.id !== res.locals.userId) { res.status(401).json({ detail: "Invalid or expired session" }); return; }
      res.json({ user: publicSupabaseUser(data.user) }); return;
    } catch { res.status(503).json({ detail: "Auth session is unavailable" }); return; }
  }
  res.json({ user: publicUser(res) });
});

authRouter.post("/bootstrap", requireAuth, async (req, res) => {
  if (!requestOriginIsWordAddin(req.get("origin")) || res.locals.principal?.provider !== "entra" || res.locals.authSource !== "bearer") {
    res.status(403).json({ detail: "Word bootstrap is unavailable" }); return;
  }
  const credential: ServerCredential = { provider: "entra", userId: res.locals.userId as string, accessToken: res.locals.token as string };
  await createServerSession(req, res, credential, tokenExpiresAt(credential.accessToken));
  res.json({ user: publicUser(res) });
});

authRouter.post("/handoff", async (req, res) => {
  const origin = req.get("origin");
  if (!requestOriginIsWordAddin(origin)) { res.status(403).json({ detail: "Untrusted handoff origin" }); return; }
  const ticket = typeof req.body?.ticket === "string" ? req.body.ticket : "";
  const requestId = typeof req.body?.requestId === "string" ? req.body.requestId : "";
  if (!ticket || !requestId) { res.status(400).json({ detail: "Invalid handoff request" }); return; }
  try {
    const credential = await consumeAuthHandoff(ticket, new URL(origin!).origin, requestId);
    if (!credential) { res.status(404).json({ detail: "Unknown or expired handoff" }); return; }
    if (!(await admit(req, res, credential))) return;
    await createServerSession(req, res, credential, tokenExpiresAt(credential.accessToken));
    res.json({ user: publicUser(res) });
  } catch { res.status(503).json({ detail: "Unable to complete sign-in" }); }
});

authRouter.post("/logout", async (req, res) => {
  if (!trusted(req, res)) return;
  try {
    if ((await authProvider()) === "supabase") {
      const current = await readServerSession(req);
      if (current?.credential.provider === "supabase") {
        const client = await createCredentialClient(current.credential);
        const { error } = await client.auth.signOut({ scope: req.body?.scope === "global" ? "global" : "local" });
        if (error) throw error;
      }
    }
    await revokeServerSession(req);
  }
  catch { res.status(503).json({ detail: "Unable to revoke session" }); return; }
  clearServerSessionCookie(req, res);
  const provider = await authProvider();
  if (provider !== "entra") { res.json({ logoutUrl: new URL("/login", frontendOrigin()).toString() }); return; }
  const tenantId = await getConfig("entra-tenant-id").catch(() => "");
  if (!tenantId) { res.json({ logoutUrl: new URL("/login", frontendOrigin()).toString() }); return; }
  const target = new URL(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/logout`);
  target.searchParams.set("post_logout_redirect_uri", new URL("/login", frontendOrigin()).toString());
  res.json({ logoutUrl: target.toString() });
});

authRouter.post("/refresh", requireAuth, (_req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ user: publicUser(res) });
});

function validEmailPassword(body: unknown): { email: string; password: string } | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  const email = typeof value.email === "string" ? value.email.trim().toLowerCase() : "";
  const password = value.password;
  return email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && typeof password === "string" && password.length >= 8 && password.length <= 1024
    ? { email, password } : null;
}

authRouter.post("/login", async (req, res) => {
  if ((await authProvider()) !== "supabase") { res.status(404).end(); return; }
  const input = validEmailPassword(req.body);
  if (!input) { res.status(400).json({ code: "invalid_request", detail: "The authentication request is invalid." }); return; }
  try {
    const { data, error } = await createSupabaseAuthClient().auth.signInWithPassword(input);
    if (error || !data.session || !data.user) { res.status(401).json({ detail: "Invalid email or password" }); return; }
    const credential = supabaseCredential(data.session);
    if (!(await admit(req, res, credential))) return;
    await createServerSession(req, res, credential, supabaseExpiresAt(data.session));
    res.json({ user: publicSupabaseUser(data.user) });
  } catch { res.status(503).json({ detail: "Sign-in is unavailable" }); }
});

authRouter.post("/signup", async (req, res) => {
  if ((await authProvider()) !== "supabase") { res.status(404).end(); return; }
  const input = validEmailPassword(req.body);
  if (!input) { res.status(400).json({ code: "invalid_request", detail: "The authentication request is invalid." }); return; }
  try {
    const { data, error } = await createSupabaseAuthClient().auth.signUp({
      ...input, options: { emailRedirectTo: safeReturnUrl("/login?confirmed=1") },
    });
    if (error || !data.user) { res.status(400).json({ detail: error?.message || "Unable to create account" }); return; }
    if (data.session) {
      const credential = supabaseCredential(data.session);
      if (!(await admit(req, res, credential))) return;
      await createServerSession(req, res, credential, supabaseExpiresAt(data.session));
    }
    res.status(201).json({ user: publicSupabaseUser(data.user), requiresEmailConfirmation: !data.session });
  } catch { res.status(503).json({ detail: "Account creation is unavailable" }); }
});

authRouter.post("/oauth", async (req, res) => {
  if ((await authProvider()) !== "supabase" || req.body?.provider !== "google") { res.status(404).end(); return; }
  const requestId = typeof req.body?.handoffRequestId === "string" ? req.body.handoffRequestId : "";
  const word = !!requestId;
  const wordOrigin = req.get("origin") || "";
  if (word && (!/^[A-Za-z0-9_-]{16,128}$/.test(requestId) || !requestOriginIsWordAddin(wordOrigin))) {
    res.status(400).json({ detail: "Invalid Word sign-in request" }); return;
  }
  try {
    const nonce = randomBytes(32).toString("base64url");
    const stateToken = randomBytes(32).toString("base64url");
    const publicOrigin = word ? wordOrigin : await backendPublicOrigin(req);
    const callback = new URL("/api/auth/oauth-callback/google", publicOrigin);
    callback.searchParams.set("state", stateToken);
    const { url, verifierState } = await startSupabaseOAuth(callback.toString());
    await createOAuthState({
      provider: "google", browserNonce: nonce, codeVerifier: verifierState,
      returnUrl: safeReturnUrl(req.body?.next), targetOrigin: word ? wordOrigin : frontendOrigin().origin,
      ...(word ? { requestId } : {}),
    }, stateToken);
    res.cookie(OAUTH_NONCE_COOKIE, nonce, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/auth", maxAge: 10 * 60_000 });
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ url });
  } catch { res.status(503).json({ detail: "Google sign-in is unavailable" }); }
});

authRouter.get("/oauth-callback/google", async (req, res) => {
  if ((await authProvider()) !== "supabase") { res.status(404).end(); return; }
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const stateToken = typeof req.query.state === "string" ? req.query.state : "";
  const nonce = req.cookies?.[OAUTH_NONCE_COOKIE];
  res.clearCookie(OAUTH_NONCE_COOKIE, { path: "/api/auth", sameSite: "lax", secure: process.env.NODE_ENV === "production" });
  res.setHeader("Cache-Control", "private, no-store");
  if (!code || typeof nonce !== "string") { res.status(400).json({ detail: "Invalid Google callback" }); return; }
  try {
    const state = await consumeOAuthState(stateToken, nonce);
    if (!state || state.provider !== "google") { res.status(400).json({ detail: "Invalid or expired Google state" }); return; }
    const { user, session } = await exchangeSupabaseOAuth(code, state.codeVerifier);
    const credential = supabaseCredential(session);
    if (!(await admit(req, res, credential))) return;
    if (state.requestId) {
      if (!requestOriginIsWordAddin(state.targetOrigin)) { res.status(400).end(); return; }
      const ticket = await createAuthHandoff(credential, state.targetOrigin, state.requestId);
      const message = JSON.stringify({ type: "mike-google-oauth", requestId: state.requestId, status: "success", handoffTicket: ticket }).replace(/</g, "\\u003c");
      res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Mike sign-in</title><script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js"></script><script>Office.onReady(() => Office.context.ui.messageParent(${message}, { targetOrigin: ${JSON.stringify(state.targetOrigin)} }));</script>`);
      return;
    }
    await createServerSession(req, res, credential, supabaseExpiresAt(session));
    res.redirect(state.returnUrl);
  } catch { res.status(503).json({ detail: "Unable to complete Google sign-in" }); }
});

authRouter.post("/password-reset", async (req, res) => {
  if ((await authProvider()) !== "supabase") { res.status(404).end(); return; }
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320) {
    try {
      const nonce = randomBytes(32).toString("base64url");
      const stateToken = randomBytes(32).toString("base64url");
      const callback = new URL("/api/auth/recovery-callback", await backendPublicOrigin(req));
      callback.searchParams.set("state", stateToken);
      const verifierState = await startSupabaseRecovery(email, callback.toString());
      await createOAuthState({ provider: "recovery", browserNonce: nonce, codeVerifier: verifierState,
        returnUrl: safeReturnUrl("/reset-password"), targetOrigin: frontendOrigin().origin }, stateToken);
      res.cookie(OAUTH_NONCE_COOKIE, nonce, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/auth", maxAge: 10 * 60_000 });
    }
    catch { /* Account enumeration stays impossible. */ }
  }
  res.status(204).end();
});

authRouter.get("/recovery-callback", async (req, res) => {
  if ((await authProvider()) !== "supabase") { res.status(404).end(); return; }
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const stateToken = typeof req.query.state === "string" ? req.query.state : "";
  const nonce = req.cookies?.[OAUTH_NONCE_COOKIE];
  res.clearCookie(OAUTH_NONCE_COOKIE, { path: "/api/auth", sameSite: "lax", secure: process.env.NODE_ENV === "production" });
  res.setHeader("Cache-Control", "private, no-store");
  if (!code || typeof nonce !== "string") { res.status(400).json({ detail: "Invalid recovery callback" }); return; }
  try {
    const state = await consumeOAuthState(stateToken, nonce);
    if (!state || state.provider !== "recovery") { res.status(400).json({ detail: "Invalid or expired recovery state" }); return; }
    const { session } = await exchangeSupabaseOAuth(code, state.codeVerifier);
    const credential = supabaseCredential(session);
    if (!(await admit(req, res, credential))) return;
    await createServerSession(req, res, credential, supabaseExpiresAt(session));
    res.redirect(state.returnUrl);
  } catch { res.status(503).json({ detail: "Unable to complete recovery" }); }
});

async function supabaseCurrent(req: Request, res: Response) {
  if ((await authProvider()) !== "supabase" || res.locals.authSource !== "cookie") {
    res.status(404).end(); return null;
  }
  const session = await readServerSession(req);
  if (!session || session.credential.provider !== "supabase" || session.credential.userId !== res.locals.userId) {
    res.status(401).json({ detail: "Invalid or expired session" }); return null;
  }
  return createCredentialClient(session.credential);
}

authRouter.patch("/email", requireAuth, async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) { res.status(400).json({ detail: "Invalid email" }); return; }
  try {
    const auth = await supabaseCurrent(req, res); if (!auth) return;
    const { data, error } = await auth.auth.updateUser({ email }, { emailRedirectTo: safeReturnUrl("/settings?emailChange=processed") });
    if (error || !data.user) { res.status(400).json({ detail: error?.message || "Unable to update email" }); return; }
    res.json({ user: publicSupabaseUser(data.user) });
  } catch { res.status(503).json({ detail: "Unable to update email" }); }
});

authRouter.patch("/password", requireAuth, async (req, res) => {
  const password = req.body?.password;
  const nonce = req.body?.nonce;
  if (typeof password !== "string" || password.length < 8 || password.length > 1024 || (nonce != null && typeof nonce !== "string")) {
    res.status(400).json({ detail: "Invalid password request" }); return;
  }
  try {
    const auth = await supabaseCurrent(req, res); if (!auth) return;
    const { data, error } = await auth.auth.updateUser({ password, ...(nonce ? { nonce } : {}) });
    if (error || !data.user) { res.status(400).json({ detail: error?.message || "Unable to update password" }); return; }
    if (req.body?.signOut === true) {
      const signedOut = await auth.auth.signOut({ scope: "global" });
      if (signedOut.error) { res.status(503).json({ detail: "Password changed, but other sessions could not be revoked" }); return; }
      await revokeServerSession(req);
      clearServerSessionCookie(req, res);
    }
    res.json({ user: publicSupabaseUser(data.user) });
  } catch { res.status(503).json({ detail: "Unable to update password" }); }
});

authRouter.post("/reauthenticate", requireAuth, async (req, res) => {
  try {
    const auth = await supabaseCurrent(req, res); if (!auth) return;
    const { error } = await auth.auth.reauthenticate();
    if (error) { res.status(400).json({ detail: error.message }); return; }
    res.status(204).end();
  } catch { res.status(503).json({ detail: "Unable to request reauthentication" }); }
});

authRouter.get("/mfa/factors", requireAuth, async (req, res) => {
  try {
    const auth = await supabaseCurrent(req, res); if (!auth) return;
    const { data, error } = await auth.auth.mfa.listFactors();
    if (error) { res.status(400).json({ detail: error.message }); return; }
    res.json(data);
  } catch { res.status(503).json({ detail: "MFA is unavailable" }); }
});

authRouter.get("/mfa/assurance", requireAuth, async (req, res) => {
  try {
    const auth = await supabaseCurrent(req, res); if (!auth) return;
    const { data, error } = await auth.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) { res.status(400).json({ detail: error.message }); return; }
    res.json(data);
  } catch { res.status(503).json({ detail: "MFA is unavailable" }); }
});

authRouter.post("/mfa/enroll", requireAuth, async (req, res) => {
  const friendlyName = typeof req.body?.friendlyName === "string" ? req.body.friendlyName.trim() : "";
  if (!friendlyName || friendlyName.length > 100) { res.status(400).json({ detail: "Invalid factor name" }); return; }
  try {
    const auth = await supabaseCurrent(req, res); if (!auth) return;
    const { data, error } = await auth.auth.mfa.enroll({ factorType: "totp", friendlyName });
    if (error) { res.status(400).json({ detail: error.message }); return; }
    res.status(201).json(data);
  } catch { res.status(503).json({ detail: "MFA is unavailable" }); }
});

authRouter.post("/mfa/challenge", requireAuth, async (req, res) => {
  const factorId = typeof req.body?.factorId === "string" ? req.body.factorId : "";
  if (!/^[A-Za-z0-9-]{1,128}$/.test(factorId)) { res.status(400).json({ detail: "Invalid factor" }); return; }
  try {
    const auth = await supabaseCurrent(req, res); if (!auth) return;
    const { data, error } = await auth.auth.mfa.challenge({ factorId });
    if (error) { res.status(400).json({ detail: error.message }); return; }
    res.json(data);
  } catch { res.status(503).json({ detail: "MFA is unavailable" }); }
});

authRouter.post("/mfa/verify", requireAuth, async (req, res) => {
  const { factorId, challengeId, code } = req.body || {};
  if (typeof factorId !== "string" || typeof challengeId !== "string" || typeof code !== "string" || !/^\d{6,8}$/.test(code)) {
    res.status(400).json({ detail: "Invalid verification request" }); return;
  }
  try {
    const auth = await supabaseCurrent(req, res); if (!auth) return;
    const { data, error } = await auth.auth.mfa.verify({ factorId, challengeId, code });
    if (error || !data.access_token || !data.refresh_token || !data.user || data.user.id !== res.locals.userId) { res.status(401).json({ detail: error?.message || "MFA verification failed" }); return; }
    await replaceServerSession(req, res, { provider: "supabase", userId: data.user.id, accessToken: data.access_token, refreshToken: data.refresh_token }, new Date(Date.now() + data.expires_in * 1000));
    res.json({ user: publicSupabaseUser(data.user) });
  } catch { res.status(503).json({ detail: "MFA is unavailable" }); }
});

authRouter.post("/mfa/challenge-and-verify", requireAuth, async (req, res) => {
  const { factorId, code } = req.body || {};
  if (typeof factorId !== "string" || typeof code !== "string" || !/^\d{6,8}$/.test(code)) {
    res.status(400).json({ detail: "Invalid verification request" }); return;
  }
  try {
    const auth = await supabaseCurrent(req, res); if (!auth) return;
    const { data, error } = await auth.auth.mfa.challengeAndVerify({ factorId, code });
    if (error || !data.access_token || !data.refresh_token || !data.user || data.user.id !== res.locals.userId) { res.status(401).json({ detail: error?.message || "MFA verification failed" }); return; }
    await replaceServerSession(req, res, { provider: "supabase", userId: data.user.id, accessToken: data.access_token, refreshToken: data.refresh_token }, new Date(Date.now() + data.expires_in * 1000));
    res.json({ user: publicSupabaseUser(data.user) });
  } catch { res.status(503).json({ detail: "MFA is unavailable" }); }
});

authRouter.delete("/mfa/factors/:factorId", requireAuth, async (req, res) => {
  const factorId = req.params.factorId;
  if (!/^[A-Za-z0-9-]{1,128}$/.test(factorId)) { res.status(400).json({ detail: "Invalid factor" }); return; }
  try {
    const auth = await supabaseCurrent(req, res); if (!auth) return;
    const { data, error } = await auth.auth.mfa.unenroll({ factorId });
    if (error) { res.status(400).json({ detail: error.message }); return; }
    res.json(data);
  } catch { res.status(503).json({ detail: "MFA is unavailable" }); }
});
