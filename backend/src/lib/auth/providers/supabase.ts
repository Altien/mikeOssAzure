import { createClient } from "@supabase/supabase-js";
import type { AuthValidationResult } from "../types.js";
import { isAuthUpstreamFailure } from "../../authUpstream";

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
