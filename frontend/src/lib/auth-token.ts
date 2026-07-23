import { getCachedAuthProvider } from "@/contexts/ConfigContext";
import { getSupabaseClient } from "@/lib/supabase";

export const ENTRA_TOKEN_KEY = "mike.entra.access_token";
export const ENTRA_USER_KEY = "mike.entra.user";
export const LOCAL_TOKEN_KEY = "mike.local.access_token";
export const LOCAL_USER_KEY = "mike.local.user";

// Refresh the entra access token once it's within this many seconds of expiry.
// Entra access tokens live ~60-90 min, so 5 min of slack covers clock skew and
// in-flight requests without refreshing on every call.
const ENTRA_REFRESH_SKEW_SECONDS = 5 * 60;

/** Read the `exp` (seconds since epoch) from a JWT, or null if unreadable. */
export function decodeJwtExp(token: string): number | null {
    try {
        const payload = token.split(".")[1];
        if (!payload) return null;
        const padded =
            payload + "=".repeat((4 - (payload.length % 4)) % 4);
        const claims = JSON.parse(
            atob(padded.replace(/-/g, "+").replace(/_/g, "/")),
        ) as { exp?: unknown };
        return typeof claims.exp === "number" ? claims.exp : null;
    } catch {
        return null;
    }
}

/** True when the token is missing an exp or is at/near expiry. */
export function entraTokenNeedsRefresh(
    token: string,
    nowSeconds: number,
    skewSeconds: number = ENTRA_REFRESH_SKEW_SECONDS,
): boolean {
    const exp = decodeJwtExp(token);
    if (exp === null) return false; // can't tell — let the 401 path handle it
    return exp - nowSeconds < skewSeconds;
}

// De-dupes concurrent refreshes: many in-flight requests near expiry should
// trigger a single /auth/refresh round-trip, not one each.
let entraRefreshInFlight: Promise<string | null> | null = null;

async function refreshEntraToken(): Promise<string | null> {
    if (!entraRefreshInFlight) {
        entraRefreshInFlight = (async () => {
            try {
                const apiBase =
                    (process.env.NEXT_PUBLIC_API_BASE_URL ??
                        "http://localhost:3001") + "/api";
                const resp = await fetch(`${apiBase}/auth/refresh`, {
                    method: "POST",
                    credentials: "include", // send the httpOnly refresh cookie
                });
                if (!resp.ok) return null;
                const data = (await resp.json()) as { access_token?: string };
                if (!data.access_token) return null;
                localStorage.setItem(ENTRA_TOKEN_KEY, data.access_token);
                return data.access_token;
            } catch {
                return null;
            } finally {
                entraRefreshInFlight = null;
            }
        })();
    }
    return entraRefreshInFlight;
}

export async function getBrowserAccessToken(): Promise<string | null> {
    const provider = getCachedAuthProvider();

    if (typeof window !== "undefined") {
        if (provider === "local") return localStorage.getItem(LOCAL_TOKEN_KEY);
        if (provider === "entra") {
            const token = localStorage.getItem(ENTRA_TOKEN_KEY);
            if (!token) return null;
            if (entraTokenNeedsRefresh(token, Math.floor(Date.now() / 1000))) {
                // Fall back to the (stale) token if refresh fails — the
                // request will 401 and bounceIfUnauthorized takes over.
                return (await refreshEntraToken()) ?? token;
            }
            return token;
        }
    }

    // supabase mode — getSupabaseClient throws if the env vars are
    // unset, which would mean we're in non-supabase mode but the
    // cached provider was wrong.  Catch and return null so the caller
    // sees "no token" instead of a thrown error.
    try {
        const supabase = getSupabaseClient();
        const { data: { session } } = await supabase.auth.getSession();
        return session?.access_token ?? null;
    } catch {
        return null;
    }
}

/**
 * Wipe all locally-stored auth state — token + user keys for both the
 * entra and local providers.  Used by the API client when the backend
 * rejects a token with 401 so the next page load shows the login UI
 * instead of bouncing through a broken authenticated state.
 *
 * Does NOT call supabase.auth.signOut() — supabase mode owns its own
 * lifecycle and recovers naturally when its session expires.
 */
export function clearStoredAuthState(): void {
    if (typeof window === "undefined") return;
    localStorage.removeItem(ENTRA_TOKEN_KEY);
    localStorage.removeItem(ENTRA_USER_KEY);
    localStorage.removeItem(LOCAL_TOKEN_KEY);
    localStorage.removeItem(LOCAL_USER_KEY);
}

/**
 * Drop-in 401 guard for any direct `fetch` against the backend.  If the
 * backend rejected the token, wipe local auth state and force-navigate
 * to /login so the next load shows the login UI cleanly.  Throws
 * `Authentication required` so the caller's existing `catch` aborts the
 * in-flight operation.
 *
 * Idempotent across simultaneous failed requests: pages 401-storming
 * because of one stale token will all hit this, all clear the same
 * keys, all set the same href.  The first one wins; the rest no-op.
 *
 * Use the wrapped helpers in mikeApi.ts (rejectIfUnauthorized) when
 * possible.  This is here for components and hooks that fetch directly.
 */
export function bounceIfUnauthorized(response: Response): void {
    if (response.status !== 401) return;
    if (typeof window === "undefined") {
        throw new Error("Authentication required");
    }
    clearStoredAuthState();
    if (!window.location.pathname.startsWith("/login")) {
        window.location.href = "/login?reason=session-expired";
    }
    throw new Error("Authentication required");
}
