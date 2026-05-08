import { NextFunction, Request, RequestHandler, Response } from "express";
import { AppRole } from "../lib/auth/roles.js";

export function requireRole(role: AppRole): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const roles: string[] = res.locals.principal?.roles ?? [];
    if (!roles.includes(role)) {
      res.status(403).json({ detail: "ROLE_REQUIRED" });
      return;
    }
    next();
  };
}
