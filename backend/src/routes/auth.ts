import { createHmac, createHash } from "node:crypto";
import { Router, type Request } from "express";

export const authRouter = Router();

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

function stateSecret(): string {
  const secret = process.env.AUTH_STATE_SECRET ?? process.env.JWT_SECRET ?? process.env.ENTRA_CLIENT_SECRET ?? "";
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("AUTH_STATE_SECRET is required for production OpenID login");
  }
  return secret || "local-dev-openid-state-secret";
}

function signState(state: AuthState): string {
  const payload = b64urlJson(state);
  const signature = b64url(createHmac("sha256", stateSecret()).update(payload).digest());
  return `${payload}.${signature}`;
}

function verifyState(rawState: unknown): AuthState | undefined {
  if (typeof rawState !== "string") return undefined;
  const [payload, signature] = rawState.split(".");
  if (!payload || !signature) return undefined;

  const expected = b64url(createHmac("sha256", stateSecret()).update(payload).digest());
  if (signature !== expected) return undefined;

  const state = JSON.parse(unb64url(payload).toString("utf8")) as Partial<AuthState>;
  if (typeof state.returnUrl !== "string" || typeof state.createdAt !== "number") return undefined;
  if (Date.now() - state.createdAt > 10 * 60 * 1000) return undefined;
  return state as AuthState;
}

function frontendUrl(): URL {
  return new URL(process.env.FRONTEND_URL ?? "http://localhost:3000");
}

function backendUrl(req: Request): string {
  const configured = process.env.BACKEND_PUBLIC_URL;
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

function entraClientId(): string {
  return process.env.ENTRA_CLIENT_ID ?? process.env.ENTRA_FRONTEND_CLIENT_ID ?? "";
}

function entraScopes(): string {
  const configured = process.env.ENTRA_AUTH_SCOPES ?? process.env.ENTRA_BACKEND_SCOPE;
  if (configured) return configured;

  const backendClientId = process.env.ENTRA_BACKEND_CLIENT_ID ?? "";
  return backendClientId ? `openid profile email offline_access api://${backendClientId}/access_as_user` : "";
}

function entraRedirectUri(req: Request): string {
  return process.env.ENTRA_REDIRECT_URI ?? `${backendUrl(req)}/api/auth/openid-callback/microsoft`;
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
  const tenantId = process.env.ENTRA_TENANT_ID ?? "";
  const clientId = entraClientId();
  const clientSecret = process.env.ENTRA_CLIENT_SECRET ?? "";
  const scopes = entraScopes();

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

authRouter.post("/local-login", (req, res) => {
  if ((process.env.AUTH_PROVIDER ?? "supabase") !== "local") {
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

authRouter.get("/providers", (_req, res) => {
  const authProvider = process.env.AUTH_PROVIDER ?? "supabase";
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
authRouter.get("/logout", (_req, res) => {
  const provider = (process.env.AUTH_PROVIDER ?? "supabase").toLowerCase();
  const loginUrl = new URL("/login", frontendUrl()).toString();

  if (provider !== "entra") {
    res.redirect(loginUrl);
    return;
  }

  const tenantId = process.env.ENTRA_TENANT_ID ?? "";
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

authRouter.get("/select-provider", (req, res) => {
  if ((process.env.AUTH_PROVIDER ?? "supabase") !== "entra") {
    res.status(404).json({ detail: "OpenID provider selection is only available when AUTH_PROVIDER=entra" });
    return;
  }

  const returnUrl = encodeURIComponent(safeReturnUrl(req.query.returnUrl));
  const selectAccount = req.query.selectAccount === "true" ? "&selectAccount=true" : "";
  res.redirect(`/api/auth/login-provider/microsoft?returnUrl=${returnUrl}${selectAccount}`);
});

authRouter.get("/login-provider/:providerId", (req, res) => {
  if (req.params.providerId !== "microsoft") {
    res.status(404).json({ detail: `Unknown auth provider '${req.params.providerId}'` });
    return;
  }
  if ((process.env.AUTH_PROVIDER ?? "supabase") !== "entra") {
    res.status(404).json({ detail: "Microsoft login is only available when AUTH_PROVIDER=entra" });
    return;
  }

  const tenantId = process.env.ENTRA_TENANT_ID ?? "";
  const clientId = entraClientId();
  const scopes = entraScopes();
  if (!tenantId || !clientId || !scopes) {
    res.status(500).json({ detail: "Missing Entra OpenID configuration" });
    return;
  }

  const authorize = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("response_mode", "query");
  authorize.searchParams.set("redirect_uri", entraRedirectUri(req));
  authorize.searchParams.set("scope", scopes);
  authorize.searchParams.set("state", signState({ returnUrl: safeReturnUrl(req.query.returnUrl), createdAt: Date.now() }));
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
  const state = verifyState(req.query.state);
  if (!code || !state) {
    res.status(400).json({ detail: "Invalid OpenID callback" });
    return;
  }

  try {
    const tokenResponse = await exchangeEntraCode(code, entraRedirectUri(req));
    res.redirect(appendTokenFragment(state.returnUrl, tokenResponse));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Failed to complete Entra login";
    const loginUrl = new URL("/login", frontendUrl());
    loginUrl.searchParams.set("error", detail);
    res.redirect(loginUrl.toString());
  }
});
