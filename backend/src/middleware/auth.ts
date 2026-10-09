import { Request, Response, NextFunction } from "express";
import { validateSupabaseToken } from "../lib/auth/providers/supabase.js";
import { validateLocalToken } from "../lib/auth/providers/local.js";
import { validateEntraToken } from "../lib/auth/providers/entra.js";
import { authorizationEmail } from "../lib/auth/types.js";
import { tenantAccess } from "./tenantAccess.js";
import { upsertUserProfile } from "../lib/userLookup.js";
import { createServerSupabase } from "../lib/supabase.js";
import { getConfig } from "../lib/config.js";
import { readServerSession, refreshServerSession } from "../lib/serverSession.js";
import { requestOriginIsTrusted } from "../lib/origins.js";
import { renewEntraCredential } from "../lib/auth/providers/entraRefresh.js";
import { renewSupabaseCredential } from "../lib/auth/providers/supabaseSession.js";
import { setCurrentUser } from "../lib/observability/sentry";

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
    {
      let session;
      try { session = await readServerSession(req); }
      catch { res.status(503).json({ detail: "Auth session is unavailable" }); return; }
      if (session?.credential.provider === provider) {
        if (Date.parse(session.row.token_expires_at) <= Date.now() + 60_000) {
          if (!session.credential.refreshToken || provider === "local") {
            res.status(401).json({ detail: "Invalid or expired session" });
            return;
          }
          try {
            const renewed = await refreshServerSession(session, provider === "supabase" ? renewSupabaseCredential : renewEntraCredential);
            const claimedVersion = session.row.version;
            session = await readServerSession(req);
            // A second replica can lose the CAS claim while the owner is
            // refreshing. Do not turn that ordinary race into a 401/logout.
            if (!renewed && session && Date.parse(session.row.token_expires_at) <= Date.now()) {
              for (let attempt = 0; attempt < 10 && session && session.row.version <= claimedVersion; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 200));
                session = await readServerSession(req);
              }
            }
            if (session && Date.parse(session.row.token_expires_at) <= Date.now()) {
              res.setHeader("Retry-After", "1");
              res.status(503).json({ detail: "Auth session refresh is in progress" });
              return;
            }
          } catch {
            res.status(503).json({ detail: "Auth session is unavailable" });
            return;
          }
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

  // A revoked cookie is insufficient for Entra: an already-issued bearer
  // token remains valid at the IdP. The durable tombstone blocks both token
  // transports before profile seeding or any application write can run.
  try {
    const { data: erasure, error: erasureError } = await createServerSupabase()
      .from("account_erasure_requests")
      .select("status")
      .eq("user_id", result.principal.userId)
      .maybeSingle();
    if (erasureError) throw erasureError;
    if (erasure) {
      res.status(410).json({ detail: "This account has been closed." });
      return;
    }
  } catch {
    res.status(503).json({ detail: "Account status is unavailable" });
    return;
  }

  res.locals.userId = result.principal.userId;
  // Grant/invitation matching input: an unconfirmed address matches nothing
  // (upstream d146998d; see authorizationEmail). The profile mirror below
  // keeps the IdP email for display.
  res.locals.userEmail = authorizationEmail(result.principal);
  res.locals.token = token;
  res.locals.principal = result.principal;
  res.locals.authSource = cookieSession ? "cookie" : "bearer";
  setCurrentUser(result.principal.userId);

  try {
    await upsertUserProfile(
      result.principal.userId,
      result.principal.email,
      result.principal.displayName,
    );
  } catch (error) {
    console.error("[auth/profile] profile initialization failed", error);
    res.status(500).json({ detail: "Unable to initialize user profile" });
    return;
  }

  await tenantAccess(req, res, next);
}
