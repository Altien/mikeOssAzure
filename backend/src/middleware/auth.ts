import { Request, Response, NextFunction } from "express";
import { isRefusedSupabaseSession, validateSupabaseToken } from "../lib/auth/providers/supabase.js";
import { validateLocalToken } from "../lib/auth/providers/local.js";
import { validateEntraToken } from "../lib/auth/providers/entra.js";
import { authorizationEmail, type AuthPrincipal } from "../lib/auth/types.js";
import { resolveTenant, runWithTenant, currentTenant, type TenantContext } from "../lib/tenantContext.js";
import { tenantAccess } from "./tenantAccess.js";
import { initializeAuthenticatedProfile } from "../lib/auth/profileAdmission";
import { getConfig } from "../lib/config.js";
import { clearServerSessionCookie, readServerSession, refreshServerSession, revokeServerSession } from "../lib/serverSession.js";
import { requestOriginIsTrusted } from "../lib/origins.js";
import { renewEntraCredential } from "../lib/auth/providers/entraRefresh.js";
import { renewSupabaseCredential } from "../lib/auth/providers/supabaseSession.js";
import { reportError, requestRoutePattern, setCurrentUser } from "../lib/observability/sentry";
import { AppError, type ErrorKind } from "../lib/appError";
import { retryAfterSeconds, takeTenantTokens, tenantRateLimits } from "../lib/tenantRateLimit.js";
import { sendInternalError, sendUpstreamUnavailable } from "../lib/httpError";
import { noteUpstreamReachable } from "../lib/upstreamOutage";

function reportAuthFailure(req: Request, kind: ErrorKind, cause: unknown): void {
  reportError(new AppError(kind, "Authentication dependency failed", { cause }), {
    tags: { component: "http", http_method: req.method, http_route: requestRoutePattern(req) },
  });
}

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
// Same for upstream dbddeea4 (MFA_REQUIRE_FOR_ENROLLED_USERS: every enrolled
// factor guards every route, profile reports mfaOnLogin; reverted upstream
// by 1b27fafc) and 7bdd9d0f (requireMfaIfEnrolled on PATCH /auth/password,
// kept upstream by 1b27fafc): NOT SUPPORTED — they build
// on the app-level MFA above, which was deferred. Keep dev's behaviour during
// conflict resolution; Entra Conditional Access owns step-up.

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
  let sessionTenantId: string | undefined;

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
      catch (error) { reportAuthFailure(req, "auth.session_lookup_failed", error); res.status(503).json({ detail: "Auth session is unavailable" }); return; }
      if (session?.credential.provider === provider) {
        if (Date.parse(session.row.token_expires_at) <= Date.now() + 60_000) {
          if (!session.credential.refreshToken || provider === "local") {
            res.status(401).json({ detail: "Invalid or expired session" });
            return;
          }
          try {
            const renewed = await refreshServerSession(session, provider === "supabase" ? renewSupabaseCredential : (refreshToken) => renewEntraCredential(refreshToken, session!.credential));
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
          } catch (error) {
            // Upstream b9f0ead8, adapted: GoTrue refused the session's refresh
            // token (revoked or already used). The visitor must sign in again,
            // which is a 401 the client already handles, not a server failure.
            // Revoke the dead server session and clear its cookie so the next
            // request does not present it again. An unreachable GoTrue is not
            // a refusal and keeps the reported 503 below.
            if (provider === "supabase" && isRefusedSupabaseSession(error)) {
              try { await revokeServerSession(req); } catch { /* the cookie is cleared regardless */ }
              clearServerSessionCookie(req, res);
              res.status(401).json({ code: "session_expired", detail: "Invalid or expired session" });
              return;
            }
            reportAuthFailure(req, "auth.session_lookup_failed", error);
            res.status(503).json({ detail: "Auth session is unavailable" });
            return;
          }
        }
        token = session?.credential.accessToken ?? "";
        sessionUserId = session?.credential.userId ?? null;
        sessionTenantId = session?.credential.tenantId;
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

  if (!result.ok && result.status === 503) {
    // GoTrue could not be reached, so nobody could say whether the session
    // is valid. A 401 here would make the web app sign the user out of a
    // session that is fine; 503 upstream_unavailable tells it to wait.
    // The handler that would name this request's flow never runs, so the
    // event is named after what failed: the session lookup.
    sendUpstreamUnavailable(
      res,
      new AppError("auth.supabase_unavailable", "session lookup could not reach GoTrue", {
        cause: result.upstreamFailure,
      }),
      { operation: "auth.session" },
    );
    return;
  }
  if (!result.ok && result.status === 500) {
    // Upstream 156d0fde: GoTrue answered with a failure of its own (a 500
    // from its database, a malformed token response): our bug to fix, not a
    // sign-out.
    sendInternalError(
      res,
      new AppError("auth.supabase_unavailable", "session lookup failed in GoTrue", {
        cause: result.failure,
      }),
    );
    return;
  }
  if (!result.ok && result.code === "session_expired") {
    // Upstream 156d0fde, adapted: GoTrue refused the session. On the cookie
    // path, revoke Dev's server session and clear its cookie so the next
    // request does not present it again.
    if (cookieSession) {
      try { await revokeServerSession(req); } catch { /* the cookie is cleared regardless */ }
      clearServerSessionCookie(req, res);
    }
    res.status(401).json({ code: "session_expired", detail: result.detail });
    return;
  }
  if (!result.ok) {
    res.status(result.status).json({ detail: result.detail });
    return;
  }
  // GoTrue answered: an outage reported earlier is over.
  if (provider === "supabase") noteUpstreamReachable();
  if (sessionUserId && result.principal.userId !== sessionUserId) {
    res.status(401).json({ detail: "Invalid or expired session" });
    return;
  }

  // Multi-tenant phase 1 (docs/issues/multi-tenant/001): the tenant comes
  // from the validated principal only, and everything from here on — the
  // erasure check, profile seeding, tenantAccess and the route handler that
  // next() reaches — runs inside its scope (lib/tenantContext.ts). With no
  // derivable tenant (entra token without `tid`) tenantAccess denies.
  const principal = result.principal;
  const authSource = cookieSession ? "cookie" : "bearer";
  let tenantId: string | undefined;
  try { tenantId = await resolveTenant(principal); }
  catch (error) {
    reportAuthFailure(req, "auth.tenant_resolution_failed", error);
    res.status(503).json({ detail: "Tenant access is unavailable" });
    return;
  }
  if (sessionTenantId && sessionTenantId !== tenantId) {
    res.status(401).json({ detail: "Invalid or expired session" }); return;
  }
  res.locals.principal = principal;
  if (!tenantId) {
    await continueAuthenticated(req, res, next, principal, token, authSource);
    return;
  }
  await runWithTenant({ tenantId, userId: principal.userId }, () =>
    continueAuthenticated(req, res, next, principal, token, authSource),
  );
}

async function continueAuthenticated(
  req: Request,
  res: Response,
  next: NextFunction,
  principal: AuthPrincipal,
  token: string,
  authSource: "cookie" | "bearer",
): Promise<void> {
  let admitted = false;
  let admittedContext: TenantContext | undefined;
  await tenantAccess(req, res, () => { admitted = true; admittedContext = currentTenant(); });
  if (!admitted) return;
  // tenantAccess returns after its callback; re-enter its trusted role scope
  // for the remaining async auth work and the actual route handler.
  if (admittedContext?.pooled) {
    await runWithTenant(admittedContext, () => finishAuthenticated(req, res, next, principal, token, authSource));
  } else await finishAuthenticated(req, res, next, principal, token, authSource);
}

async function finishAuthenticated(
  req: Request, res: Response, next: NextFunction, principal: AuthPrincipal, token: string,
  authSource: "cookie" | "bearer",
): Promise<void> {
  // The erasure tombstone, profile seeding and personal organization run
  // here, inside the admitted tenant's scope (lib/auth/profileAdmission.ts).
  const profileError = await initializeAuthenticatedProfile(principal);
  if (profileError) {
    if (profileError.failure) reportAuthFailure(req, profileError.failure.kind, profileError.failure.cause);
    res.status(profileError.status).json({ detail: profileError.detail });
    return;
  }

  res.locals.userId = principal.userId;
  // Grant/invitation matching input: an unconfirmed address matches nothing
  // (upstream d146998d; see authorizationEmail). The profile mirror below
  // keeps the IdP email for display.
  res.locals.userEmail = authorizationEmail(principal);
  res.locals.token = token;
  res.locals.principal = principal;
  res.locals.authSource = authSource;
  setCurrentUser(principal.userId);

  // Shared per-tenant request limit (multi-tenant issue 017), after the
  // tenant is admitted so an unknown tenant never gets a bucket. Off unless
  // TENANT_REQUESTS_PER_MINUTE is set.
  const { requestsPerMinute } = tenantRateLimits();
  if (requestsPerMinute <= 0) {
    next();
    return;
  }
  {
    const taken = await takeTenantTokens("requests", 1, requestsPerMinute);
    if (taken.allowed) {
      next();
      return;
    }
    res.setHeader("Retry-After", String(retryAfterSeconds(taken.retryAfterMs)));
    res.status(429).json({
      detail: "Too many requests for your organisation. Please try again later.",
    });
  }
}
