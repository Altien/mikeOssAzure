import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Upstream divergence (OSS-6, auth): upstream exports an eagerly-built
// `supabase` client and every component calls `supabase.auth.getSession()`.
// Dev's auth mode is chosen at runtime (GET /config → entra | local |
// supabase), so the client is a lazy, mode-gated factory. Components get
// their bearer token from `getBrowserAccessToken()` in `@/app/lib/auth-token`
// instead; only the supabase-mode branches of AuthContext, auth-token and
// the login/signup pages reach for this client.
//
// Constructs the client on first call, caches the instance.  Throws a
// clear error when called in a deployment that has no NEXT_PUBLIC_SUPABASE_*
// env vars — that always means the call site is reaching for supabase
// in a non-supabase deployment.  Use the auth-provider check from
// ConfigContext to gate calls in code paths that run in multiple modes.

let _client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
    if (_client) return _client;

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;

    if (!url || !key) {
        throw new Error(
            "Supabase client requested but NEXT_PUBLIC_SUPABASE_URL / " +
                "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY are not set. " +
                "Check authProvider in /config — supabase mode is required " +
                "to use this client.",
        );
    }

    _client = createClient(url, key);
    return _client;
}
