import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the two collaborators before importing the SUT.  vi.hoisted lets
// the mocks reference fresh spies that the tests can reach into per-case.
const { mockGetCachedAuthProvider, mockGetSupabaseClient } = vi.hoisted(() => ({
    mockGetCachedAuthProvider: vi.fn<() => "supabase" | "local" | "entra">(),
    mockGetSupabaseClient: vi.fn(),
}));

vi.mock("@/contexts/ConfigContext", () => ({
    getCachedAuthProvider: mockGetCachedAuthProvider,
}));

vi.mock("@/lib/supabase", () => ({
    getSupabaseClient: mockGetSupabaseClient,
}));

import {
    ENTRA_TOKEN_KEY,
    ENTRA_USER_KEY,
    LOCAL_TOKEN_KEY,
    LOCAL_USER_KEY,
    getBrowserAccessToken,
    clearStoredAuthState,
    bounceIfUnauthorized,
} from "./auth-token";

describe("auth-token: storage-key contract", () => {
    // These string literals are read by the backend logout flow and by
    // pages that probe for an authenticated user without a React
    // context.  Changing any of them is a coordinated change across
    // frontend + middleware + docs, so the test pins them.
    it("exports the four expected localStorage keys", () => {
        expect(ENTRA_TOKEN_KEY).toBe("mike.entra.access_token");
        expect(ENTRA_USER_KEY).toBe("mike.entra.user");
        expect(LOCAL_TOKEN_KEY).toBe("mike.local.access_token");
        expect(LOCAL_USER_KEY).toBe("mike.local.user");
    });
});

describe("auth-token: getBrowserAccessToken", () => {
    beforeEach(() => {
        mockGetCachedAuthProvider.mockReset();
        mockGetSupabaseClient.mockReset();
    });

    it("returns the localStorage entra token in entra mode", async () => {
        mockGetCachedAuthProvider.mockReturnValue("entra");
        window.localStorage.setItem(ENTRA_TOKEN_KEY, "entra-token-abc");

        const result = await getBrowserAccessToken();

        expect(result).toBe("entra-token-abc");
        expect(mockGetSupabaseClient).not.toHaveBeenCalled();
    });

    it("returns the localStorage local token in local mode", async () => {
        mockGetCachedAuthProvider.mockReturnValue("local");
        window.localStorage.setItem(LOCAL_TOKEN_KEY, "local-token-xyz");

        const result = await getBrowserAccessToken();

        expect(result).toBe("local-token-xyz");
        expect(mockGetSupabaseClient).not.toHaveBeenCalled();
    });

    it("returns null in entra mode when no token is stored", async () => {
        mockGetCachedAuthProvider.mockReturnValue("entra");

        const result = await getBrowserAccessToken();

        expect(result).toBeNull();
        expect(mockGetSupabaseClient).not.toHaveBeenCalled();
    });

    it("returns null in local mode when no token is stored", async () => {
        mockGetCachedAuthProvider.mockReturnValue("local");

        const result = await getBrowserAccessToken();

        expect(result).toBeNull();
        expect(mockGetSupabaseClient).not.toHaveBeenCalled();
    });

    it("does NOT consult entra/local storage in supabase mode", async () => {
        // If the provider fork leaks (e.g. the function checks entra
        // storage first regardless of mode), this test catches it.
        mockGetCachedAuthProvider.mockReturnValue("supabase");
        window.localStorage.setItem(ENTRA_TOKEN_KEY, "wrong-token");
        window.localStorage.setItem(LOCAL_TOKEN_KEY, "also-wrong");
        mockGetSupabaseClient.mockReturnValue({
            auth: {
                getSession: vi.fn().mockResolvedValue({
                    data: { session: { access_token: "supabase-token" } },
                }),
            },
        });

        const result = await getBrowserAccessToken();

        expect(result).toBe("supabase-token");
        expect(mockGetSupabaseClient).toHaveBeenCalledOnce();
    });

    it("returns the supabase session access_token in supabase mode", async () => {
        mockGetCachedAuthProvider.mockReturnValue("supabase");
        const getSession = vi.fn().mockResolvedValue({
            data: { session: { access_token: "supabase-token-123" } },
        });
        mockGetSupabaseClient.mockReturnValue({ auth: { getSession } });

        const result = await getBrowserAccessToken();

        expect(result).toBe("supabase-token-123");
        expect(getSession).toHaveBeenCalledOnce();
    });

    it("returns null in supabase mode when there is no session", async () => {
        mockGetCachedAuthProvider.mockReturnValue("supabase");
        mockGetSupabaseClient.mockReturnValue({
            auth: {
                getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
            },
        });

        const result = await getBrowserAccessToken();

        expect(result).toBeNull();
    });

    it("returns null in supabase mode when getSupabaseClient throws", async () => {
        // Important branch: if the cached provider says "supabase" but
        // the env vars are unset, getSupabaseClient throws.  We swallow
        // the error and return null so callers see "no token" instead
        // of an exception they have to special-case.
        mockGetCachedAuthProvider.mockReturnValue("supabase");
        mockGetSupabaseClient.mockImplementation(() => {
            throw new Error("Supabase client requested but env vars unset");
        });

        const result = await getBrowserAccessToken();

        expect(result).toBeNull();
    });

    it("returns null when supabase.auth.getSession rejects", async () => {
        mockGetCachedAuthProvider.mockReturnValue("supabase");
        mockGetSupabaseClient.mockReturnValue({
            auth: {
                getSession: vi.fn().mockRejectedValue(new Error("network down")),
            },
        });

        const result = await getBrowserAccessToken();

        expect(result).toBeNull();
    });
});

describe("auth-token: clearStoredAuthState", () => {
    it("removes all four entra + local keys", () => {
        window.localStorage.setItem(ENTRA_TOKEN_KEY, "et");
        window.localStorage.setItem(ENTRA_USER_KEY, "eu");
        window.localStorage.setItem(LOCAL_TOKEN_KEY, "lt");
        window.localStorage.setItem(LOCAL_USER_KEY, "lu");

        clearStoredAuthState();

        expect(window.localStorage.getItem(ENTRA_TOKEN_KEY)).toBeNull();
        expect(window.localStorage.getItem(ENTRA_USER_KEY)).toBeNull();
        expect(window.localStorage.getItem(LOCAL_TOKEN_KEY)).toBeNull();
        expect(window.localStorage.getItem(LOCAL_USER_KEY)).toBeNull();
    });

    it("leaves the supabase provider-cache key untouched", () => {
        // Supabase mode owns its own session lifecycle; clearing the
        // provider cache here would force a /config re-fetch on next
        // load and break the cached-provider fast path.
        window.localStorage.setItem("mike.config.authProvider", "supabase");
        window.localStorage.setItem(ENTRA_TOKEN_KEY, "et");

        clearStoredAuthState();

        expect(window.localStorage.getItem("mike.config.authProvider")).toBe("supabase");
        expect(window.localStorage.getItem(ENTRA_TOKEN_KEY)).toBeNull();
    });

    it("leaves unrelated localStorage entries untouched", () => {
        window.localStorage.setItem("mike.user.preferences", "{}");
        window.localStorage.setItem("mike.recent.docs", "[]");

        clearStoredAuthState();

        expect(window.localStorage.getItem("mike.user.preferences")).toBe("{}");
        expect(window.localStorage.getItem("mike.recent.docs")).toBe("[]");
    });

    it("is idempotent — calling twice is the same as once", () => {
        window.localStorage.setItem(LOCAL_TOKEN_KEY, "lt");

        clearStoredAuthState();
        clearStoredAuthState();

        expect(window.localStorage.getItem(LOCAL_TOKEN_KEY)).toBeNull();
    });
});

describe("auth-token: bounceIfUnauthorized", () => {
    const ORIGINAL_LOCATION = window.location;

    beforeEach(() => {
        // jsdom's window.location is special — we replace it with a
        // plain object so we can observe href assignments without the
        // engine refusing to navigate.
        Object.defineProperty(window, "location", {
            configurable: true,
            writable: true,
            value: {
                pathname: "/some/page",
                href: "http://localhost/some/page",
            },
        });
    });

    afterEach(() => {
        Object.defineProperty(window, "location", {
            configurable: true,
            writable: true,
            value: ORIGINAL_LOCATION,
        });
    });

    function fakeResponse(status: number): Response {
        return { status } as Response;
    }

    it("is a no-op for 2xx responses", () => {
        window.localStorage.setItem(ENTRA_TOKEN_KEY, "et");

        bounceIfUnauthorized(fakeResponse(200));

        expect(window.localStorage.getItem(ENTRA_TOKEN_KEY)).toBe("et");
        expect(window.location.href).toBe("http://localhost/some/page");
    });

    it("is a no-op for 4xx errors that are not 401", () => {
        window.localStorage.setItem(LOCAL_TOKEN_KEY, "lt");

        bounceIfUnauthorized(fakeResponse(403));
        bounceIfUnauthorized(fakeResponse(404));
        bounceIfUnauthorized(fakeResponse(500));

        expect(window.localStorage.getItem(LOCAL_TOKEN_KEY)).toBe("lt");
        expect(window.location.href).toBe("http://localhost/some/page");
    });

    it("on 401: clears auth state, redirects to /login, and throws", () => {
        window.localStorage.setItem(ENTRA_TOKEN_KEY, "et");
        window.localStorage.setItem(LOCAL_TOKEN_KEY, "lt");

        expect(() => bounceIfUnauthorized(fakeResponse(401))).toThrow(
            "Authentication required",
        );

        expect(window.localStorage.getItem(ENTRA_TOKEN_KEY)).toBeNull();
        expect(window.localStorage.getItem(LOCAL_TOKEN_KEY)).toBeNull();
        expect(window.location.href).toBe("/login?reason=session-expired");
    });

    it("does NOT redirect if we are already on a /login page", () => {
        // Without this guard the page would refresh-loop: /login fetches
        // /api/auth/providers, that 401s, we redirect to /login, repeat.
        window.location.pathname = "/login";
        window.location.href = "http://localhost/login";

        expect(() => bounceIfUnauthorized(fakeResponse(401))).toThrow(
            "Authentication required",
        );

        // location.href must NOT have been rewritten
        expect(window.location.href).toBe("http://localhost/login");
    });

    it("treats nested /login paths the same", () => {
        // startsWith("/login") so /login/foo also counts as "already
        // there" and should not bounce.
        window.location.pathname = "/login/callback";
        window.location.href = "http://localhost/login/callback";

        expect(() => bounceIfUnauthorized(fakeResponse(401))).toThrow();

        expect(window.location.href).toBe("http://localhost/login/callback");
    });

    it("still clears auth state even when not redirecting (already on /login)", () => {
        window.location.pathname = "/login";
        window.localStorage.setItem(ENTRA_USER_KEY, "stale-user");

        expect(() => bounceIfUnauthorized(fakeResponse(401))).toThrow();

        expect(window.localStorage.getItem(ENTRA_USER_KEY)).toBeNull();
    });
});

describe("auth-token: SSR / no-window paths", () => {
    // These three tests cover the defensive `typeof window === "undefined"`
    // branches.  In production they fire when a server component or
    // server-rendered page accidentally imports a client-side helper.
    // The guards must fail closed: no localStorage access, no redirect,
    // no thrown TypeError trying to read a property of undefined.

    function withoutWindow<T>(fn: () => T): T {
        const real = Object.getOwnPropertyDescriptor(globalThis, "window");
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: undefined,
        });
        try {
            return fn();
        } finally {
            if (real) Object.defineProperty(globalThis, "window", real);
        }
    }

    it("clearStoredAuthState is a no-op in SSR (no window)", () => {
        // Just exercising the guard — the function should return cleanly.
        expect(() => withoutWindow(() => clearStoredAuthState())).not.toThrow();
    });

    it("bounceIfUnauthorized throws on 401 without touching location in SSR", () => {
        expect(() =>
            withoutWindow(() =>
                bounceIfUnauthorized({ status: 401 } as Response),
            ),
        ).toThrow("Authentication required");
    });

    it("getBrowserAccessToken skips entra/local localStorage in SSR", async () => {
        // Entra-mode in SSR can't read localStorage, so it falls through
        // to the supabase branch.  Mocked supabase throws → null.
        mockGetCachedAuthProvider.mockReturnValue("entra");
        mockGetSupabaseClient.mockImplementation(() => {
            throw new Error("no env vars on the server");
        });

        const result = await withoutWindow(() => getBrowserAccessToken());

        expect(result).toBeNull();
    });
});
