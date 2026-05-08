import { createClient } from "@supabase/supabase-js";
import type { AuthValidationResult } from "../types.js";

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
  const { data } = await admin.auth.getUser(token);
  if (!data.user) {
    return { ok: false, status: 401, detail: "Invalid or expired token" };
  }

  return {
    ok: true,
    principal: {
      userId: data.user.id,
      email: data.user.email?.toLowerCase() ?? "",
      groups: [],
      roles: [],
      provider: "supabase",
    },
  };
}
