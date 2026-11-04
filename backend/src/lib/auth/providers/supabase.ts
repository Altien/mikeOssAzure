import { createClient } from "@supabase/supabase-js";
import type { AuthValidationResult } from "../types.js";
import { isAuthUpstreamFailure } from "../../authUpstream";

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
