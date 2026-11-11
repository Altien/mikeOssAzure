import { createClient } from "@supabase/supabase-js";
import type { AuthValidationResult } from "../types.js";
import { authErrorShape, isAuthUpstreamFailure } from "../../authUpstream";

/**
 * Did GoTrue refuse this session (a refresh token revoked or already used,
 * a JWT for a session that no longer exists)? Only a 4xx AuthApiError counts:
 * auth-js's isAuthError also matches AuthRetryableFetchError, and treating an
 * outage as a refusal would sign the user out of a session that may be fine.
 * Looks through one `cause` level, since renewSupabaseCredential wraps it.
 * Duck-typed on auth-js's `__isAuthError` marker, like lib/authUpstream.ts.
 * (Upstream b9f0ead8 / 156d0fde, adapted to Dev's server session.)
 */
export function isRefusedSupabaseSession(error: unknown): boolean {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    if (!candidate || typeof candidate !== "object" || !("__isAuthError" in candidate)) continue;
    const { name, status } = candidate as { name?: unknown; status?: unknown };
    if (name === "AuthApiError" && typeof status === "number" && status >= 400 && status < 500) return true;
  }
  return false;
}

export async function validateSupabaseToken(
  token: string,
): Promise<AuthValidationResult> {
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SECRET_KEY ?? "";

  if (!supabaseUrl || !serviceKey) {
    return { ok: false, status: 401, detail: "Server auth is not configured" };
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  // auth-js returns, rather than throws, the error behind a missing user.
  const { data, error } = await admin.auth.getUser(token);
  if (!data.user && isAuthUpstreamFailure(error)) {
    return { ok: false, status: 503, detail: "Authentication provider is unreachable", upstreamFailure: error };
  }
  // Upstream 156d0fde, adapted: classify the failure from the error getUser
  // returns. A refused session is a 401 the client treats as signed out; a
  // GoTrue 500 is a reported server failure; anything else (no user at all)
  // keeps the plain 401.
  if (!data.user && isRefusedSupabaseSession(error)) {
    return { ok: false, status: 401, detail: "Invalid or expired session", code: "session_expired" };
  }
  // Upstream b8490837 moved requireAuth's authErrorShape into authUpstream.ts.
  const failureStatus = data.user ? undefined : authErrorShape(error)?.status;
  if (failureStatus !== undefined && failureStatus >= 500) {
    return { ok: false, status: 500, detail: "Authentication provider failed", failure: error };
  }
  if (!data.user) {
    return { ok: false, status: 401, detail: "Invalid or expired token" };
  }

  return {
    ok: true,
    principal: {
      userId: data.user.id,
      email: data.user.email?.toLowerCase() ?? "",
      emailVerified: Boolean(data.user.email_confirmed_at),
      groups: [],
      roles: [],
      provider: "supabase",
    },
  };
}
