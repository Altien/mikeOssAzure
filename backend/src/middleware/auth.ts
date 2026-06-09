import { Request, Response, NextFunction } from "express";
import { validateSupabaseToken } from "../lib/auth/providers/supabase.js";
import { validateLocalToken } from "../lib/auth/providers/local.js";
import { validateEntraToken } from "../lib/auth/providers/entra.js";
import { tenantAccess } from "./tenantAccess.js";
import { upsertUserProfile } from "../lib/userSettings.js";

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
  if (!auth.startsWith("Bearer ")) {
    res.status(401).json({ detail: "Missing or invalid Authorization header" });
    return;
  }
  const token = auth.slice(7).trim();

  const provider = process.env.AUTH_PROVIDER ?? "supabase";

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

  res.locals.userId = result.principal.userId;
  res.locals.userEmail = result.principal.email;
  res.locals.token = token;
  res.locals.principal = result.principal;

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
