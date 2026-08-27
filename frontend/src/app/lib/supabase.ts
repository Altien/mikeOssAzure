import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | undefined;

export function getBrowserSupabase(): SupabaseClient {
    if (client) return client;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
    const key =
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY?.trim() ?? "";
    if (!url || !key) {
        throw new Error(
            "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY must be set when NEXT_PUBLIC_MIKE_AUTH_PROVIDER=supabase",
        );
    }
    client = createClient(url, key);
    return client;
}

/**
 * Eager-looking client for the Supabase-only auth screens (Google sign-in,
 * password reset, the OAuth callback). It is a lazy proxy on purpose: a
 * local-auth deployment has no Supabase env, and constructing the real client
 * at module load would throw simply because one of those modules was imported.
 * Resolution is deferred to first property access, which only those screens do.
 */
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
    get(_target, property, receiver) {
        return Reflect.get(getBrowserSupabase(), property, receiver);
    },
});
