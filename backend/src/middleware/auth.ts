import { Request, Response, NextFunction } from "express";
import { validateSupabaseToken } from "../lib/auth/providers/supabase.js";

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
  } else {
    res
      .status(500)
      .json({ detail: `Auth provider '${provider}' is not yet implemented` });
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
  next();
}
