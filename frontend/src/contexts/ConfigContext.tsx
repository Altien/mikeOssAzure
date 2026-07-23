"use client";

// Runtime config delivered by GET /config on the backend.  Replaces the
// build-time NEXT_PUBLIC_AUTH_PROVIDER / NEXT_PUBLIC_ENTRA_* baking that
// used to tie a frontend image to one specific tenant.  Same image now
// runs against any deployment; only the server's env / Key Vault values
// vary.
//
// Helpers below the React context expose the resolved provider as a
// localStorage cache so module-level functions (getBrowserAccessToken,
// getSupabaseClient) can answer questions like "are we in entra mode?"
// without needing a React hook context.

import {
    createContext,
    useContext,
    useEffect,
    useState,
    type ReactNode,
} from "react";

export type AuthProvider = "supabase" | "local" | "entra";

export interface RuntimeConfig {
    authProvider: AuthProvider;
    demoMode: boolean;
    entra: {
        tenantId: string;
        clientId: string;
    };
}

const DEFAULT_CONFIG: RuntimeConfig = {
    authProvider: "supabase",
    demoMode: false,
    entra: { tenantId: "", clientId: "" },
};

const CONFIG_PROVIDER_CACHE_KEY = "mike.config.authProvider";

// Exported for the test harness (src/test/render.tsx) to inject config.
export const ConfigContext = createContext<{ config: RuntimeConfig; loading: boolean }>(
    { config: DEFAULT_CONFIG, loading: true },
);

function readCachedProvider(): AuthProvider {
    if (typeof window === "undefined") return "supabase";
    const cached = window.localStorage.getItem(CONFIG_PROVIDER_CACHE_KEY);
    if (cached === "entra" || cached === "local" || cached === "supabase") {
        return cached;
    }
    return "supabase";
}

function writeCachedProvider(provider: AuthProvider) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(CONFIG_PROVIDER_CACHE_KEY, provider);
}

/**
 * Module-level read of the cached auth provider.  Use sparingly — prefer
 * `useConfig()` from React.  Exists so module-level helpers can answer
 * "what auth mode are we in?" without needing the React context tree.
 *
 * On the very first page load before /config has resolved, this returns
 * "supabase" (the upstream default).  ConfigProvider rewrites the cache
 * on mount, so subsequent reads are correct.
 */
export function getCachedAuthProvider(): AuthProvider {
    return readCachedProvider();
}

export function ConfigProvider({ children }: { children: ReactNode }) {
    const [config, setConfig] = useState<RuntimeConfig>(() => ({
        ...DEFAULT_CONFIG,
        authProvider: readCachedProvider(),
    }));
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;

        const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
        fetch(`${apiBase}/config`, { credentials: "omit" })
            .then((response) => {
                if (!response.ok) throw new Error(`/config ${response.status}`);
                return response.json() as Promise<RuntimeConfig>;
            })
            .then((next) => {
                if (cancelled) return;
                setConfig(next);
                writeCachedProvider(next.authProvider);
            })
            .catch((err) => {
                console.warn(
                    "[config] failed to load runtime config; falling back to cached provider",
                    err,
                );
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, []);

    return (
        <ConfigContext.Provider value={{ config, loading }}>
            {children}
        </ConfigContext.Provider>
    );
}

export function useConfig(): RuntimeConfig {
    return useContext(ConfigContext).config;
}

export function useConfigLoading(): boolean {
    return useContext(ConfigContext).loading;
}
