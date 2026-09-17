import { getConfig } from "../../lib/config";

/** Resolve the configured identity provider without probing optional GoTrue. */
export async function authProvider(): Promise<string> {
  return (await getConfig("auth-provider").catch(() => process.env.AUTH_PROVIDER || "supabase")) || "supabase";
}
