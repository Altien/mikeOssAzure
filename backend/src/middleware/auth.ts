import { Request, Response, NextFunction } from "express";
import { validateSupabaseToken } from "../lib/auth/providers/supabase.js";
import { validateLocalToken } from "../lib/auth/providers/local.js";
import { validateEntraToken } from "../lib/auth/providers/entra.js";
import { tenantAccess } from "./tenantAccess.js";
import { upsertUserProfile } from "../lib/userSettings.js";

// Validate the bearer token, populate res.locals.{userId,userEmail,token,principal}
// and ensure the user profile row exists. Returns a boolean: true on success
// (caller should continue), false on failure (caller must NOT continue; this
// function has already written the error response).
async function loadPrincipal(req: Request, res: Response): Promise<boolean> {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) {
    res.status(401).json({ detail: "Missing or invalid Authorization header" });
    return false;
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
    res
      .status(500)
      .json({ detail: `Auth provider '${provider}' is not yet implemented` });
    return false;
  }

  if (!result.ok) {
    res.status(result.status).json({ detail: result.detail });
    return false;
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
    const detail =
      error instanceof Error
        ? error.message
        : "Unable to initialize user profile";
    res.status(500).json({ detail });
    return false;
  }

  return true;
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!(await loadPrincipal(req, res))) return;
  await tenantAccess(req, res, next);
}

// Same as requireAuth but skips tenantAccess. Used by /diag, the operator
// diagnostic page, so a user who is signed in but not yet whitelisted by
// ENTRA_*_GROUP_IDS can still see the page and find the right OID to put
// in the env var. The diag page must not expose any tenant data; it only
// reflects the JWT and env-var values back to the operator.
export async function requireValidJwt(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!(await loadPrincipal(req, res))) return;
  next();
}
