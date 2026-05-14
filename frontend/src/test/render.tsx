import { ReactElement, ReactNode } from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { ConfigContext, type RuntimeConfig } from "@/contexts/ConfigContext";
import { AuthContext } from "@/contexts/AuthContext";

interface TestUser {
    id: string;
    email: string;
}

type Opts = {
    config?: Partial<RuntimeConfig>;
    configLoading?: boolean;
    user?: TestUser | null;
    authLoading?: boolean;
    signInLocal?: (email: string) => Promise<void>;
    signOut?: () => Promise<void>;
    getAccessToken?: () => Promise<string | null>;
} & Omit<RenderOptions, "wrapper">;

/**
 * Render a UI tree wrapped in Config + Auth contexts with values you
 * control directly — no /config fetch, no supabase client, no real
 * Entra token decode.  Tests of the *providers themselves* should use
 * the real providers and let MSW respond; this helper is for everything
 * downstream of the provider boundary.
 */
export function renderWithProviders(ui: ReactElement, opts: Opts = {}) {
    const {
        config: configOverride,
        configLoading = false,
        user = null,
        authLoading = false,
        signInLocal = async () => {},
        signOut = async () => {},
        getAccessToken,
        ...renderOptions
    } = opts;

    const config: RuntimeConfig = {
        authProvider: "supabase",
        entra: { tenantId: "", clientId: "" },
        ...configOverride,
    };

    const auth = {
        user,
        isAuthenticated: user !== null,
        authLoading,
        signInLocal,
        signOut,
        getAccessToken:
            getAccessToken ?? (async () => (user ? "fake-token" : null)),
    };

    function Wrapper({ children }: { children: ReactNode }) {
        return (
            <ConfigContext.Provider value={{ config, loading: configLoading }}>
                <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
            </ConfigContext.Provider>
        );
    }

    return render(ui, { wrapper: Wrapper, ...renderOptions });
}
