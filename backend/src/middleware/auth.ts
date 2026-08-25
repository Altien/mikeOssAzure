import { Request, Response, NextFunction } from "express";
import { validateSupabaseToken } from "../lib/auth/providers/supabase.js";
import { validateLocalToken } from "../lib/auth/providers/local.js";
import { validateEntraToken } from "../lib/auth/providers/entra.js";
import { tenantAccess } from "./tenantAccess.js";
import { upsertUserProfile } from "../lib/userSettings.js";
import { getConfig } from "../lib/config.js";
import { createRequestSupabase } from "../lib/authSession.js";
import { readServerSession, refreshServerSession } from "../lib/serverSession.js";
import { requestOriginIsTrusted } from "../lib/origins.js";
import { renewEntraCredential } from "../lib/auth/providers/entraRefresh.js";

// Upstream divergence (sync-log: 3a10943): upstream added app-level MFA
// enforcement here (enforceLoginMfaIfEnabled / requireMfaIfEnrolled) built
// on Supabase Auth's MFA APIs (admin.auth.mfa.getAuthenticatorAssuranceLevel,
// auth.getUser factor listings). Dev's auth is provider-pluggable
// (supabase | local | entra) with Entra as the production provider; those
// Supabase Auth MFA primitives do not exist for Entra, where MFA/step-up is
// enforced by the identity provider (Conditional Access), not application
// code. NOT adopted — do not re-introduce Supabase-session MFA checks in
// this middleware. If app-level step-up is ever needed, it must be designed
// per-provider behind lib/auth/providers/.

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = req.headers.authorization ?? "";
  const provider = (await getConfig("auth-provider").catch(() => process.env.AUTH_PROVIDER)) ?? "supabase";
  let token = "";
  let cookieSession = false;
  let sessionUserId: string | null = null;

  // An explicit credential has precedence. Invalid or malformed bearer
  // headers never fall back to a different identity in a browser cookie.
  if (auth) {
    if (!auth.startsWith("Bearer ") || !auth.slice(7).trim()) {
      res.status(401).json({ detail: "Invalid Authorization header" });
      return;
    }
    token = auth.slice(7).trim();
  } else {
    // Cookie-authenticated writes need a browser Origin. Bearer API clients
    // remain callable without an Origin header.
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !requestOriginIsTrusted(req.get("origin"))) {
      res.status(403).json({ code: "untrusted_origin", detail: "The request origin is not allowed." });
      return;
    }
    cookieSession = true;
    if (provider === "supabase") {
      try {
        const client = createRequestSupabase(req, res);
        const { data, error } = await client.auth.getSession();
        if (!error) token = data.session?.access_token ?? "";
        res.locals.authClient = client;
      } catch {
        res.status(503).json({ detail: "Auth session is unavailable" });
        return;
      }
    } else {
      let session;
      try { session = await readServerSession(req); }
      catch { res.status(503).json({ detail: "Auth session is unavailable" }); return; }
      if (session?.credential.provider === provider) {
        if (Date.parse(session.row.token_expires_at) <= Date.now() + 60_000) {
          if (provider !== "entra" || !session.credential.refreshToken) {
            res.status(401).json({ detail: "Invalid or expired session" });
            return;
          }
          try {
            const renewed = await refreshServerSession(session, renewEntraCredential);
            session = renewed ? await readServerSession(req) : null;
          } catch { session = null; }
        }
        token = session?.credential.accessToken ?? "";
        sessionUserId = session?.credential.userId ?? null;
      }
    }
  }

  if (!token) {
    res.status(401).json({ detail: "Invalid or expired session" });
    return;
  }

  let result;
  if (provider === "supabase") {
    result = await validateSupabaseToken(token);
  } else if (provider === "local") {
    result = await validateLocalToken(token);
  } else if (provider === "entra") {
    result = await validateEntraToken(token);
  } else {
    res.status(500).json({ detail: `Auth provider '${provider}' is not yet implemented` });
    return;
  }

  if (!result.ok) {
    res.status(result.status).json({ detail: result.detail });
    return;
  }
  if (sessionUserId && result.principal.userId !== sessionUserId) {
    res.status(401).json({ detail: "Invalid or expired session" });
    return;
  }

  res.locals.userId = result.principal.userId;
  res.locals.userEmail = result.principal.email;
  res.locals.token = token;
  res.locals.principal = result.principal;
  res.locals.authSource = cookieSession ? "cookie" : "bearer";

  try {
    await upsertUserProfile(
      result.principal.userId,
      result.principal.email,
      result.principal.displayName,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unable to initialize user profile";
    res.status(500).json({ detail });
    return;
  }

  await tenantAccess(req, res, next);
}
