import type { NextFunction, Request, Response } from "express";
import {
  ensureLocalProfile,
  findLocalUserById,
  findSession,
} from "../lib/sqlite";

const AAL1_ALLOWED_PREFIXES = ["/mfa/"];
const AAL1_ALLOWED_PATHS = new Set(["/profile", "/security/mfa-status"]);

function isLocalAal1Allowed(req: Request): boolean {
  if (AAL1_ALLOWED_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
    return true;
  }
  return req.method === "GET" && AAL1_ALLOWED_PATHS.has(req.path);
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

  if (await authenticateLocal(req, res, token)) next();
}

export function localAuthOnly(
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  next();
}

export function requireMfaIfEnrolled(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.locals.mfaVerified === false) {
    res.status(403).json({
      detail: "MFA verification required",
      code: "mfa_verification_required",
    });
    return;
  }
  next();
}
