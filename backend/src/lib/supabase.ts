import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cachedAdminClient:
  | {
      url: string;
      key: string;
      client: SupabaseClient<any, "public", any>;
    }
  | undefined;

/**
 * Server-side Supabase client using the service-role key.
 *
 * This is MikeOSS's upstream persistence path. The service role bypasses RLS,
 * so callers must authenticate the request and scope every query to the
 * current user before using this client.
 */
export function createServerSupabase() {
  const url = process.env.SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SECRET_KEY?.trim() ?? "";
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SECRET_KEY must be set when MIKE_DATABASE_PROVIDER=supabase",
    );
  }
  if (cachedAdminClient?.url === url && cachedAdminClient.key === key) {
    return cachedAdminClient.client;
  }

  const client = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  cachedAdminClient = { url, key, client };
  return client;
}
