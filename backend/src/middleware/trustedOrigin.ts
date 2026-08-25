import type { NextFunction, Request, Response } from "express";
import { requestOriginIsTrusted } from "../lib/origins";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function requireTrustedOrigin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  const origin = req.get("origin");
  if (!requestOriginIsTrusted(origin)) {
    res.status(403).json({
      code: "untrusted_origin",
      detail: "The request origin is not allowed.",
    });
    return;
  }
  next();
}
