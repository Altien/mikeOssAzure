import { createHmac, createHash } from "node:crypto";
import { Router, type Request } from "express";
import { getConfig } from "../lib/config.js";

export const authRouter = Router();

// Reads runtime config from KV via getConfig() — env-first fallback
// preserves existing env-wired installs while supporting KV-only
// installs and live updates from /install (after flushConfigCache).
// Gap #1 in docs/issues/azure-migration/036-marketplace-install-gaps.md.
async function readAuthProvider(): Promise<string> {
  return (await getConfig("auth-provider").catch(() => "")) || "supabase";
}

interface OpenIdTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  id_token?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

interface AuthState {
  returnUrl: string;
  createdAt: number;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlJson(value: unknown): string {
  return b64url(JSON.stringify(value));
}

function unb64url(input: string): Buffer {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

async function stateSecret(): Promise<string> {
  // auth-state-secret: KV-owned, seeded by Bicep at greenfield deploy
  // (random GUID) and never rotated automatically. Falls back to legacy
  // JWT_SECRET / ENTRA_CLIENT_SECRET so older installs that pre-date
  // the dedicated secret keep working.
  const fromKv = await getConfig("auth-state-secret").catch(() => "");
  const secret = fromKv || process.env.JWT_SECRET || process.env.ENTRA_CLIENT_SECRET || "";
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("auth-state-secret is required for production OpenID login");
  }
  return secret || "local-dev-openid-state-secret";
}

async function signState(state: AuthState): Promise<string> {
  const payload = b64urlJson(state);
  const secret = await stateSecret();
  const signature = b64url(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${signature}`;
}

async function verifyState(rawState: unknown): Promise<AuthState | undefined> {
  if (typeof rawState !== "string") return undefined;
  const [payload, signature] = rawState.split(".");
  if (!payload || !signature) return undefined;

  const secret = await stateSecret();
  const expected = b64url(createHmac("sha256", secret).update(payload).digest());
  if (signature !== expected) return undefined;

  const state = JSON.parse(unb64url(payload).toString("utf8")) as Partial<AuthState>;
  if (typeof state.returnUrl !== "string" || typeof state.createdAt !== "number") return undefined;
  if (Date.now() - state.createdAt > 10 * 60 * 1000) return undefined;
  return state as AuthState;
}

function frontendUrl(): URL {
  return new URL(process.env.FRONTEND_URL ?? "http://localhost:3000");
}

async function backendUrl(req: Request): Promise<string> {
  const configured = (await getConfig("backend-public-url").catch(() => "")) || "";
  if (configured) return configured.replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

function safeReturnUrl(rawReturnUrl: unknown): string {
  const fallback = new URL("/assistant", frontendUrl());
  const candidate = typeof rawReturnUrl === "string" && rawReturnUrl.trim()
    ? rawReturnUrl.trim()
    : fallback.toString();

  const resolved = new URL(candidate, frontendUrl());
  if (resolved.origin !== frontendUrl().origin) return fallback.toString();
  return resolved.toString();
}

async function entraClientId(): Promise<string> {
  // ENTRA_FRONTEND_CLIENT_ID is the legacy env-var name; preserved as a
  // fallback for installs that haven't migrated.
  return (await getConfig("entra-client-id").catch(() => "")) ||
    process.env.ENTRA_FRONTEND_CLIENT_ID ||
    "";
}

// Scope passed to the Entra OAuth endpoints. The backend's access_as_user
// scope is fully deterministic from the backend app reg's client id
// (api://<guid>/access_as_user), so storing it as a separate KV secret /
// env var was redundant — and a frequent source of "install all green but
// scope missing" failures (gap #4 in
// docs/issues/azure-migration/036-marketplace-install-gaps.md). The only
// override path that survives is ENTRA_AUTH_SCOPES, intended for
// operators with non-standard scope sets (e.g. additional Graph
// permissions). Plain ENTRA_BACKEND_SCOPE is no longer read.
async function entraScopes(): Promise<string> {
  const override = process.env.ENTRA_AUTH_SCOPES;
  if (override) return override;

  const backendClientId = await getConfig("entra-backend-client-id").catch(() => "");
  return backendClientId ? `openid profile email offline_access api://${backendClientId}/access_as_user` : "";
}

async function entraRedirectUri(req: Request): Promise<string> {
  return process.env.ENTRA_REDIRECT_URI ?? `${await backendUrl(req)}/api/auth/openid-callback/microsoft`;
}

function appendTokenFragment(returnUrl: string, tokenResponse: OpenIdTokenResponse): string {
  const target = new URL(returnUrl);
  const fragment = new URLSearchParams();
  fragment.set("access_token", tokenResponse.access_token ?? "");
  fragment.set("token_type", tokenResponse.token_type ?? "Bearer");
  if (typeof tokenResponse.expires_in === "number") {
    fragment.set("expires_in", String(tokenResponse.expires_in));
  }
  target.hash = fragment.toString();
  return target.toString();
}

async function exchangeEntraCode(code: string, redirectUri: string): Promise<OpenIdTokenResponse> {
  const [tenantId, clientId, clientSecret, scopes] = await Promise.all([
    getConfig("entra-tenant-id").catch(() => ""),
    entraClientId(),
    getConfig("entra-client-secret").catch(() => ""),
    entraScopes(),
  ]);

  if (!tenantId || !clientId || !scopes) {
    throw new Error("Missing Entra OpenID configuration");
  }

  const form = new URLSearchParams({
    client_id: clientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    scope: scopes,
  });
  if (clientSecret) form.set("client_secret", clientSecret);

  const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const tokenResponse = (await response.json()) as OpenIdTokenResponse;
  if (!response.ok || !tokenResponse.access_token) {
    throw new Error(tokenResponse.error_description ?? tokenResponse.error ?? "Failed to exchange Entra authorization code");
  }
  return tokenResponse;
}

function localUserId(email: string): string {
  const hex = createHash("sha256").update(email.toLowerCase()).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function mintLocalToken(secret: string, email: string): { token: string; user: { id: string; email: string } } {
  const now = Math.floor(Date.now() / 1000);
  const user = { id: localUserId(email), email };
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    role: "authenticated",
    sub: user.id,
    email: user.email,
    iat: now,
    exp: now + 8 * 60 * 60,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = b64url(createHmac("sha256", secret).update(signingInput).digest());
  return { token: `${signingInput}.${signature}`, user };
}

authRouter.post("/local-login", async (req, res) => {
  if ((await readAuthProvider()) !== "local") {
    res.status(404).json({ detail: "Local login is only available when AUTH_PROVIDER=local" });
    return;
  }

  const secret = process.env.JWT_SECRET ?? "";
  if (!secret) {
    res.status(500).json({ detail: "JWT_SECRET is required for local login" });
    return;
  }

  const email = typeof req.body?.email === "string" && req.body.email.trim()
    ? req.body.email.trim().toLowerCase()
    : "local.user@example.com";

  res.json(mintLocalToken(secret, email));
});

authRouter.get("/providers", async (_req, res) => {
  const authProvider = await readAuthProvider();
  res.json({
    defaultProvider: authProvider === "entra" ? "microsoft" : authProvider,
    providers: [
      {
        id: "microsoft",
        name: "Microsoft",
        mode: "openid",
        enabled: authProvider === "entra",
      },
    ],
  });
});

// Sign-out redirect.  Server constructs the right post-logout URL so
// the browser bundle does not need to know the tenant ID or any other
// customer-specific value.  In entra mode, redirects through Microsoft
// so the IdP session is cleared too; in other modes, just back to the
// app's login page.
authRouter.get("/logout", async (_req, res) => {
  const provider = (await readAuthProvider()).toLowerCase();
  const loginUrl = new URL("/login", frontendUrl()).toString();

  if (provider !== "entra") {
    res.redirect(loginUrl);
    return;
  }

  const tenantId = await getConfig("entra-tenant-id").catch(() => "");
  if (!tenantId) {
    // Misconfigured entra mode — at least get the user back to the
    // login page rather than 500-ing on sign-out.
    res.redirect(loginUrl);
    return;
  }

  const microsoftLogout = new URL(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/logout`,
  );
  microsoftLogout.searchParams.set("post_logout_redirect_uri", loginUrl);
  res.redirect(microsoftLogout.toString());
});

authRouter.get("/select-provider", async (req, res) => {
  if ((await readAuthProvider()) !== "entra") {
    res.status(404).json({ detail: "OpenID provider selection is only available when AUTH_PROVIDER=entra" });
    return;
  }

  const returnUrl = encodeURIComponent(safeReturnUrl(req.query.returnUrl));
  const selectAccount = req.query.selectAccount === "true" ? "&selectAccount=true" : "";
  res.redirect(`/api/auth/login-provider/microsoft?returnUrl=${returnUrl}${selectAccount}`);
});

authRouter.get("/login-provider/:providerId", async (req, res) => {
  if (req.params.providerId !== "microsoft") {
    res.status(404).json({ detail: `Unknown auth provider '${req.params.providerId}'` });
    return;
  }
  if ((await readAuthProvider()) !== "entra") {
    res.status(404).json({ detail: "Microsoft login is only available when AUTH_PROVIDER=entra" });
    return;
  }

  const [tenantId, clientId, scopes, redirectUri] = await Promise.all([
    getConfig("entra-tenant-id").catch(() => ""),
    entraClientId(),
    entraScopes(),
    entraRedirectUri(req),
  ]);
  if (!tenantId || !clientId || !scopes) {
    res.status(500).json({ detail: "Missing Entra OpenID configuration" });
    return;
  }

  // signState() throws in production when no auth-state-secret is configured.
  // It is async (KV-backed), so Express 4 won't forward the rejection to an
  // error handler — catch it here and return 500 rather than hang the request.
  let state: string;
  try {
    state = await signState({ returnUrl: safeReturnUrl(req.query.returnUrl), createdAt: Date.now() });
  } catch (err) {
    console.error("OpenID login-provider failed to sign state:", err);
    res.status(500).json({ detail: "OpenID login is not configured" });
    return;
  }
  const authorize = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("response_mode", "query");
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", scopes);
  authorize.searchParams.set("state", state);
  if (req.query.selectAccount === "true") {
    authorize.searchParams.set("prompt", "select_account");
  }

  res.redirect(authorize.toString());
});

authRouter.get("/openid-callback/:providerId", async (req, res) => {
  if (req.params.providerId !== "microsoft") {
    res.status(404).json({ detail: `Unknown OpenID provider '${req.params.providerId}'` });
    return;
  }

  if (typeof req.query.error === "string") {
    res.status(400).json({ detail: req.query.error_description ?? req.query.error });
    return;
  }

  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = await verifyState(req.query.state);
  if (!code || !state) {
    res.status(400).json({ detail: "Invalid OpenID callback" });
    return;
  }

  try {
    const redirectUri = await entraRedirectUri(req);
    const tokenResponse = await exchangeEntraCode(code, redirectUri);
    res.redirect(appendTokenFragment(state.returnUrl, tokenResponse));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Failed to complete Entra login";
    const loginUrl = new URL("/login", frontendUrl());
    loginUrl.searchParams.set("error", detail);
    res.redirect(loginUrl.toString());
  }
});
