import type { NextFunction, Request, Response } from "express";
import { resolveAuthProvider } from "../lib/authProvider";
import {
  ensureLocalProfile,
  findLocalUserById,
  findSession,
} from "../lib/sqlite";
import { createServerSupabase } from "../lib/supabase";
import { syncProfileEmail } from "../lib/userLookup";
import { sendInternalError } from "../lib/httpError";
import { safeErrorLog } from "../lib/safeError";

const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
  if (isDev) console.log(...args);
};

const AAL1_ALLOWED_PREFIXES = ["/mfa/"];
const AAL1_ALLOWED_PATHS = new Set(["/profile", "/security/mfa-status"]);

function isLocalAal1Allowed(req: Request): boolean {
  if (AAL1_ALLOWED_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
    return true;
  }
  return req.method === "GET" && AAL1_ALLOWED_PATHS.has(req.path);
}

function isSupabaseMfaBootstrapRoute(req: Request): boolean {
  const path = req.originalUrl.split("?")[0];
  if (path === "/auth/session" || path.startsWith("/auth/mfa/")) {
    return true;
  }
  return (
    (req.method === "GET" || req.method === "POST") &&
    (path === "/user/profile" || path === "/users/profile")
  );
}

function bearerToken(req: Request): string | null {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  return token || null;
}

async function authenticateLocal(
  req: Request,
  res: Response,
  token: string,
): Promise<boolean> {
  const session = findSession(token);
  if (!session) {
    res.status(401).json({ detail: "Invalid or expired token" });
    return false;
  }
  const user = findLocalUserById(session.userId) as
    | { id: string; email?: string }
    | null;
  if (!user) {
    res.status(401).json({ detail: "Invalid or expired token" });
    return false;
  }
  if (!session.mfaVerified && !isLocalAal1Allowed(req)) {
    res.status(403).json({
      detail: "MFA verification required",
      code: "mfa_verification_required",
    });
    return false;
  }

  res.locals.userId = user.id;
  res.locals.userEmail = user.email?.toLowerCase() ?? "";
  res.locals.token = token;
  res.locals.mfaVerified = session.mfaVerified;
  await ensureLocalProfile(user.id, user.email ?? null);
  return true;
}

async function authenticateSupabase(
  req: Request,
  res: Response,
  token: string,
): Promise<boolean> {
  let admin;
  try {
    admin = createServerSupabase();
  } catch {
    res.status(500).json({ detail: "Server auth is not configured" });
    return false;
  }

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ detail: "Invalid or expired token" });
    return false;
  }

  res.locals.userId = data.user.id;
  res.locals.userEmail = data.user.email?.toLowerCase() ?? "";
  res.locals.token = token;
  const syncError = await syncProfileEmail(admin, data.user.id, data.user.email);
  if (syncError && process.env.NODE_ENV !== "production") {
    console.warn("[auth/profile-email] sync failed", syncError.message);
  }

  if (isSupabaseMfaBootstrapRoute(req)) return true;
  const { data: profile, error: profileError } = await admin
    .from("user_profiles")
    .select("mfa_on_login")
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (profileError && profileError.code !== "42703") {
    res.status(500).json({ detail: profileError.message });
    return false;
  }
  if ((profile as { mfa_on_login?: boolean } | null)?.mfa_on_login !== true) {
    return true;
  }

  const { data: assurance, error: assuranceError } =
    await admin.auth.mfa.getAuthenticatorAssuranceLevel(token);
  if (assuranceError) {
    devLog("[auth/mfa] login assurance lookup failed", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
      error: assuranceError.message,
    });
    console.error(
      "[auth/mfa] login assurance lookup failed",
      assuranceError,
    );
    res.status(401).json({
      code: "authentication_failed",
      detail: "Unable to verify authentication. Please sign in again.",
    });
    return false;
  }
  res.locals.mfaVerified = assurance.currentLevel === "aal2";
  if (assurance.nextLevel === "aal2" && assurance.currentLevel !== "aal2") {
    res.status(403).json({
      code: "mfa_verification_required",
      detail: "MFA verification required",
    });
    return false;
  }
  return true;
}

function getAdminClient(res: Response) {
  try {
    return createServerSupabase();
  } catch {
    res.status(500).json({ detail: "Server auth is not configured" });
    return null;
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ detail: "Missing or invalid Authorization header" });
    return;
  }

  const authenticated =
    resolveAuthProvider() === "local"
      ? await authenticateLocal(req, res, token)
      : await authenticateSupabase(req, res, token);
  if (authenticated) next();
}

export function localAuthOnly(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (resolveAuthProvider() !== "local") {
    res.status(404).json({ detail: "Local authentication is not enabled" });
    return;
  }
  next();
}

export async function requireMfaIfEnrolled(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (resolveAuthProvider() === "local") {
    if (res.locals.mfaVerified === false) {
      res.status(403).json({
        detail: "MFA verification required",
        code: "mfa_verification_required",
      });
      return;
    }
    next();
    return;
  }

  const token = typeof res.locals.token === "string" ? res.locals.token : "";
  if (!token) {
    res.status(401).json({ detail: "Missing auth session" });
    return;
  }
  const admin = getAdminClient(res);
  if (!admin) return;
  const { data, error } =
    await admin.auth.mfa.getAuthenticatorAssuranceLevel(token);
  if (error) {
    devLog("[auth/mfa] assurance lookup failed", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
      error: error.message,
    });
    console.error("[auth/mfa] assurance lookup failed", error);
    res.status(401).json({
      code: "authentication_failed",
      detail: "Unable to verify authentication. Please sign in again.",
    });
    return;
  }
  if (data.nextLevel === "aal2" && data.currentLevel !== "aal2") {
    res.status(403).json({
      code: "mfa_verification_required",
      detail: "MFA verification required",
    });
    return;
  }
  next();
}
