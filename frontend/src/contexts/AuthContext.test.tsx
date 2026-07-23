import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { server } from "@/test/msw-server";
import { ConfigContext, type RuntimeConfig } from "./ConfigContext";
import { AuthProvider, useAuth } from "./AuthContext";
import {
    ENTRA_TOKEN_KEY,
    ENTRA_USER_KEY,
    LOCAL_TOKEN_KEY,
    LOCAL_USER_KEY,
} from "@/lib/auth-token";

// supabase client — mocked at the module boundary.  Tests build a
// per-case fake and inject it through this spy.
const { mockGetSupabaseClient } = vi.hoisted(() => ({
    mockGetSupabaseClient: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({
    getSupabaseClient: mockGetSupabaseClient,
}));

// The provider reads getBrowserAccessToken from auth-token.ts; the SUT
// path that calls it is `getAccessToken`, which is exposed via
// useAuth().  We let the real implementation run — it's already
// covered by auth-token.test.ts and the integration here is the point.

function makeConfig(authProvider: RuntimeConfig["authProvider"]): RuntimeConfig {
    return {
        authProvider,
        demoMode: false,
        entra: { tenantId: "tenant-1", clientId: "client-1" },
    };
}

function ConfigShim({
    children,
    config,
    loading = false,
}: {
    children: ReactNode;
    config: RuntimeConfig;
    loading?: boolean;
}) {
    return (
        <ConfigContext.Provider value={{ config, loading }}>
            {children}
        </ConfigContext.Provider>
    );
}

function AuthProbe() {
    const auth = useAuth();
    return (
        <div>
            <span data-testid="email">{auth.user?.email ?? "no-user"}</span>
            <span data-testid="id">{auth.user?.id ?? "no-id"}</span>
            <span data-testid="auth-loading">
                {auth.authLoading ? "loading" : "ready"}
            </span>
            <span data-testid="is-auth">
                {auth.isAuthenticated ? "yes" : "no"}
            </span>
            <button onClick={() => auth.signInLocal("user@example.com")}>
                sign-in-local
            </button>
            <button onClick={() => auth.signOut()}>sign-out</button>
            <button
                onClick={async () => {
                    const token = await auth.getAccessToken();
                    const el = document.createElement("span");
                    el.dataset.testid = "token";
                    el.textContent = token ?? "null";
                    document.body.appendChild(el);
                }}
            >
                get-token
            </button>
        </div>
    );
}

describe("AuthContext: gating on configLoading", () => {
    it("stays authLoading=true while configLoading=true", () => {
        render(
            <ConfigShim config={makeConfig("supabase")} loading={true}>
                <AuthProvider>
                    <AuthProbe />
                </AuthProvider>
            </ConfigShim>,
        );

        // The provider's effect early-returns when configLoading is
        // true, leaving authLoading at its initial true value.  The
        // exposed authLoading is (authLoading || configLoading), so
        // it stays loading regardless of which side flipped.
        expect(screen.getByTestId("auth-loading")).toHaveTextContent("loading");
        expect(screen.getByTestId("is-auth")).toHaveTextContent("no");
    });
});

describe("AuthContext: supabase mode", () => {
    let unsubscribe: ReturnType<typeof vi.fn>;
    let authStateCallback: ((event: string, session: unknown) => Promise<void>) | null;

    beforeEach(() => {
        unsubscribe = vi.fn();
        authStateCallback = null;
        mockGetSupabaseClient.mockReturnValue({
            auth: {
                getSession: vi.fn().mockResolvedValue({
                    data: {
                        session: {
                            user: { id: "u-1", email: "alice@example.com" },
                        },
                    },
                }),
                onAuthStateChange: vi.fn((cb) => {
                    authStateCallback = cb;
                    return { data: { subscription: { unsubscribe } } };
                }),
                signOut: vi.fn().mockResolvedValue({ error: null }),
            },
        });
    });

    it("restores the session on mount and flips authLoading to ready", async () => {
        render(
            <ConfigShim config={makeConfig("supabase")}>
                <AuthProvider>
                    <AuthProbe />
                </AuthProvider>
            </ConfigShim>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("auth-loading")).toHaveTextContent("ready"),
        );
        expect(screen.getByTestId("email")).toHaveTextContent("alice@example.com");
        expect(screen.getByTestId("id")).toHaveTextContent("u-1");
        expect(screen.getByTestId("is-auth")).toHaveTextContent("yes");
    });

    it("falls back to empty email when supabase user has no email", async () => {
        // The SUT uses `email: session.user.email || ""`, so a null
        // email becomes the empty string — user is still
        // authenticated (id is enough for isAuthenticated), email
        // just isn't displayable.
        mockGetSupabaseClient.mockReturnValue({
            auth: {
                getSession: vi.fn().mockResolvedValue({
                    data: { session: { user: { id: "u-2", email: null } } },
                }),
                onAuthStateChange: vi.fn(() => ({
                    data: { subscription: { unsubscribe } },
                })),
                signOut: vi.fn(),
            },
        });

        render(
            <ConfigShim config={makeConfig("supabase")}>
                <AuthProvider>
                    <AuthProbe />
                </AuthProvider>
            </ConfigShim>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("auth-loading")).toHaveTextContent("ready"),
        );
        // Empty string — the `||` in the SUT is the nullish guard.
        expect(screen.getByTestId("email").textContent).toBe("");
        expect(screen.getByTestId("id")).toHaveTextContent("u-2");
        expect(screen.getByTestId("is-auth")).toHaveTextContent("yes");
    });

    it("renders unauthenticated when getSession returns no session", async () => {
        mockGetSupabaseClient.mockReturnValue({
            auth: {
                getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
                onAuthStateChange: vi.fn(() => ({
                    data: { subscription: { unsubscribe } },
                })),
                signOut: vi.fn(),
            },
        });

        render(
            <ConfigShim config={makeConfig("supabase")}>
                <AuthProvider>
                    <AuthProbe />
                </AuthProvider>
            </ConfigShim>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("auth-loading")).toHaveTextContent("ready"),
        );
        expect(screen.getByTestId("is-auth")).toHaveTextContent("no");
    });

    it("updates state when onAuthStateChange fires with a session", async () => {
        render(
            <ConfigShim config={makeConfig("supabase")}>
                <AuthProvider>
                    <AuthProbe />
                </AuthProvider>
            </ConfigShim>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("auth-loading")).toHaveTextContent("ready"),
        );

        // Simulate supabase telling us about a new user.
        await act(async () => {
            await authStateCallback!("SIGNED_IN", {
                user: { id: "u-99", email: "bob@example.com" },
            });
        });

        expect(screen.getByTestId("email")).toHaveTextContent("bob@example.com");
        expect(screen.getByTestId("id")).toHaveTextContent("u-99");
    });

    it("clears the user when onAuthStateChange fires with no session", async () => {
        render(
            <ConfigShim config={makeConfig("supabase")}>
                <AuthProvider>
                    <AuthProbe />
                </AuthProvider>
            </ConfigShim>,
        );
        await waitFor(() =>
            expect(screen.getByTestId("is-auth")).toHaveTextContent("yes"),
        );

        await act(async () => {
            await authStateCallback!("SIGNED_OUT", null);
        });

        expect(screen.getByTestId("is-auth")).toHaveTextContent("no");
        expect(screen.getByTestId("email")).toHaveTextContent("no-user");
    });

    it("unsubscribes from the auth-state listener on unmount", async () => {
        const { unmount } = render(
            <ConfigShim config={makeConfig("supabase")}>
                <AuthProvider>
                    <AuthProbe />
                </AuthProvider>
            </ConfigShim>,
        );
        await waitFor(() =>
            expect(screen.getByTestId("auth-loading")).toHaveTextContent("ready"),
        );

        unmount();

        expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it("signOut calls supabase.auth.signOut and clears the user", async () => {
        render(
            <ConfigShim config={makeConfig("supabase")}>
                <AuthProvider>
                    <AuthProbe />
                </AuthProvider>
            </ConfigShim>,
        );
        await waitFor(() =>
            expect(screen.getByTestId("is-auth")).toHaveTextContent("yes"),
        );

        await userEvent.click(screen.getByText("sign-out"));

        const supabase = mockGetSupabaseClient.mock.results[0]!.value;
        expect(supabase.auth.signOut).toHaveBeenCalledOnce();
        await waitFor(() =>
            expect(screen.getByTestId("is-auth")).toHaveTextContent("no"),
        );
    });
});

describe("AuthContext: local mode", () => {
    it("restores a stored local user on mount", async () => {
        window.localStorage.setItem(
            LOCAL_USER_KEY,
            JSON.stringify({ id: "u-local", email: "local@example.com" }),
        );

        render(
            <ConfigShim config={makeConfig("local")}>
                <AuthProvider>
                    <AuthProbe />
                </AuthProvider>
            </ConfigShim>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("auth-loading")).toHaveTextContent("ready"),
        );
        expect(screen.getByTestId("email")).toHaveTextContent("local@example.com");
        expect(screen.getByTestId("id")).toHaveTextContent("u-local");
    });

    it("clears corrupt stored-user JSON and stays unauthenticated", async () => {
        window.localStorage.setItem(LOCAL_USER_KEY, "{not json");
        window.localStorage.setItem(LOCAL_TOKEN_KEY, "a-token");

        render(
            <ConfigShim config={makeConfig("local")}>
                <AuthProvider>
                    <AuthProbe />
                </AuthProvider>
            </ConfigShim>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("auth-loading")).toHaveTextContent("ready"),
        );
        expect(screen.getByTestId("is-auth")).toHaveTextContent("no");
        // The corrupt-JSON branch must also drop the paired token so a
        // future read doesn't think the user is signed in.
        expect(window.localStorage.getItem(LOCAL_USER_KEY)).toBeNull();
        expect(window.localStorage.getItem(LOCAL_TOKEN_KEY)).toBeNull();
    });

    it("does not consult the supabase client", async () => {
        render(
            <ConfigShim config={makeConfig("local")}>
                <AuthProvider>
                    <AuthProbe />
                </AuthProvider>
            </ConfigShim>,
        );
        await waitFor(() =>
            expect(screen.getByTestId("auth-loading")).toHaveTextContent("ready"),
        );

        expect(mockGetSupabaseClient).not.toHaveBeenCalled();
    });

    it("signInLocal POSTs to /api/auth/local-login and stores the token + user", async () => {
        let receivedBody: unknown;
        let receivedContentType: string | null = null;
        server.use(
            http.post("*/api/auth/local-login", async ({ request }) => {
                receivedBody = await request.json();
                receivedContentType = request.headers.get("Content-Type");
                return HttpResponse.json({
                    token: "minted-token-xyz",
                    user: { id: "u-new", email: "user@example.com" },
                });
            }),
        );
        render(
            <ConfigShim config={makeConfig("local")}>
                <AuthProvider>
                    <AuthProbe />
                </AuthProvider>
            </ConfigShim>,
        );
        await waitFor(() =>
            expect(screen.getByTestId("auth-loading")).toHaveTextContent("ready"),
        );

        await userEvent.click(screen.getByText("sign-in-local"));

        await waitFor(() =>
            expect(screen.getByTestId("email")).toHaveTextContent("user@example.com"),
        );
        expect(receivedBody).toEqual({ email: "user@example.com" });
        expect(receivedContentType).toBe("application/json");
        expect(window.localStorage.getItem(LOCAL_TOKEN_KEY)).toBe("minted-token-xyz");
        expect(window.localStorage.getItem(LOCAL_USER_KEY)).toBe(
            JSON.stringify({ id: "u-new", email: "user@example.com" }),
        );
    });

    it("signInLocal throws the response text on a non-2xx", async () => {
        server.use(
            http.post("*/api/auth/local-login", () =>
                HttpResponse.text("local login disabled", { status: 404 }),
            ),
        );
        function Inline() {
            const auth = useAuth();
            return (
                <button
                    onClick={async () => {
                        try {
                            await auth.signInLocal("user@example.com");
                            const ok = document.createElement("span");
                            ok.dataset.testid = "result";
                            ok.textContent = "ok";
                            document.body.appendChild(ok);
                        } catch (err) {
                            const fail = document.createElement("span");
                            fail.dataset.testid = "result";
                            fail.textContent = (err as Error).message;
                            document.body.appendChild(fail);
                        }
                    }}
                >
                    sign-in
                </button>
            );
        }

        render(
            <ConfigShim config={makeConfig("local")}>
                <AuthProvider>
                    <Inline />
                </AuthProvider>
            </ConfigShim>,
        );
        await userEvent.click(screen.getByText("sign-in"));

        await waitFor(() =>
            expect(screen.getByTestId("result")).toHaveTextContent(
                "local login disabled",
            ),
        );
        expect(window.localStorage.getItem(LOCAL_TOKEN_KEY)).toBeNull();
    });

    it("signOut clears the local token + user and flips to unauthenticated", async () => {
        window.localStorage.setItem(LOCAL_TOKEN_KEY, "t");
        window.localStorage.setItem(
            LOCAL_USER_KEY,
            JSON.stringify({ id: "u", email: "u@x" }),
        );

        render(
            <ConfigShim config={makeConfig("local")}>
                <AuthProvider>
                    <AuthProbe />
                </AuthProvider>
            </ConfigShim>,
        );
        await waitFor(() =>
            expect(screen.getByTestId("is-auth")).toHaveTextContent("yes"),
        );

        await userEvent.click(screen.getByText("sign-out"));

        await waitFor(() =>
            expect(screen.getByTestId("is-auth")).toHaveTextContent("no"),
        );
        expect(window.localStorage.getItem(LOCAL_TOKEN_KEY)).toBeNull();
        expect(window.localStorage.getItem(LOCAL_USER_KEY)).toBeNull();
    });
});

// Helper: build a JWT-shape string with the given claims.  No signature
// verification happens client-side — decodeJwtUser only inspects the
// payload segment.  An empty signature is fine.
function makeJwt(claims: Record<string, unknown>): string {
    const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" }));
    const payload = btoa(JSON.stringify(claims))
        .replace(/=+$/, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
    return `${header}.${payload}.`;
}

describe("AuthContext: entra mode", () => {
    const ORIGINAL_LOCATION = window.location;
    const ORIGINAL_HISTORY_REPLACE = window.history.replaceState;

    beforeEach(() => {
        Object.defineProperty(window, "location", {
            configurable: true,
            writable: true,
            value: {
                hash: "",
                pathname: "/",
                search: "",
                href: "http://localhost/",
            },
        });
        window.history.replaceState = vi.fn();
    });

    afterEach(() => {
        Object.defineProperty(window, "location", {
            configurable: true,
            writable: true,
            value: ORIGINAL_LOCATION,
        });
        window.history.replaceState = ORIGINAL_HISTORY_REPLACE;
    });

    it("extracts a token from the URL fragment, stores it, decodes the user, and strips the hash", async () => {
        const token = makeJwt({
            oid: "entra-oid-1",
            preferred_username: "USER@CONTOSO.COM",
        });
        window.location.hash = `#access_token=${token}&token_type=Bearer`;
        window.location.pathname = "/post-login";
        window.location.search = "?foo=bar";

        render(
            <ConfigShim config={makeConfig("entra")}>
                <AuthProvider>
                    <AuthProbe />
                </AuthProvider>
            </ConfigShim>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("auth-loading")).toHaveTextContent("ready"),
        );
        expect(screen.getByTestId("id")).toHaveTextContent("entra-oid-1");
        // Email is lower-cased — important because backend tenant
        // lookups are case-insensitive but the comparison key is the
        // lower-cased form.
        expect(screen.getByTestId("email")).toHaveTextContent("user@contoso.com");
        expect(window.localStorage.getItem(ENTRA_TOKEN_KEY)).toBe(token);
        // The fragment must be wiped so a back-button navigation
        // doesn't leak the access token in the URL bar.
        expect(window.history.replaceState).toHaveBeenCalledWith(
            null,
            "",
            "/post-login?foo=bar",
        );
    });

    it("falls back through sub when oid is missing", async () => {
        const token = makeJwt({ sub: "entra-sub-2", upn: "alt@contoso.com" });
        window.location.hash = `#access_token=${token}`;

        render(
            <ConfigShim config={makeConfig("entra")}>
                <AuthProvider>
                    <AuthProbe />
                </AuthProvider>
            </ConfigShim>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("id")).toHaveTextContent("entra-sub-2"),
        );
        // preferred_username → email → upn fallback.
        expect(screen.getByTestId("email")).toHaveTextContent("alt@contoso.com");
    });

    it("falls back to the email claim when preferred_username is absent", async () => {
        const token = makeJwt({ oid: "o-3", email: "Foo@Bar.com" });
        window.location.hash = `#access_token=${token}`;

        render(
            <ConfigShim config={makeConfig("entra")}>
                <AuthProvider>
                    <AuthProbe />
                </AuthProvider>
            </ConfigShim>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("email")).toHaveTextContent("foo@bar.com"),
        );
    });

    it("uses the placeholder when no usable claims are present", async () => {
        // decodeJwtUser falls back to id="entra-user", email="" when
        // nothing matches.  The empty email is meaningful — the user
        // is technically signed in (token persisted) but unsignable.
        const token = makeJwt({});
        window.location.hash = `#access_token=${token}`;

        render(
            <ConfigShim config={makeConfig("entra")}>
                <AuthProvider>
                    <AuthProbe />
                </AuthProvider>
            </ConfigShim>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("id")).toHaveTextContent("entra-user"),
        );
        expect(screen.getByTestId("email").textContent).toBe("");
    });

    it("falls back to the placeholder user when the token payload is unparseable", async () => {
        // Two dots, a payload segment that base64-decodes but isn't
        // JSON.  decodeJwtUser must catch and return the placeholder.
        const garbage = `aaa.${btoa("not-json")}.`;
        window.location.hash = `#access_token=${garbage}`;

        render(
            <ConfigShim config={makeConfig("entra")}>
                <AuthProvider>
                    <AuthProbe />
                </AuthProvider>
            </ConfigShim>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("id")).toHaveTextContent("entra-user"),
        );
        expect(screen.getByTestId("email").textContent).toBe("");
    });

    it("loads a previously-stored entra user when there's no token in the URL", async () => {
        window.localStorage.setItem(
            ENTRA_USER_KEY,
            JSON.stringify({ id: "stored-oid", email: "stored@contoso.com" }),
        );

        render(
            <ConfigShim config={makeConfig("entra")}>
                <AuthProvider>
                    <AuthProbe />
                </AuthProvider>
            </ConfigShim>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("email")).toHaveTextContent(
                "stored@contoso.com",
            ),
        );
        expect(window.history.replaceState).not.toHaveBeenCalled();
    });

    it("clears corrupt stored entra user JSON", async () => {
        window.localStorage.setItem(ENTRA_USER_KEY, "{broken");
        window.localStorage.setItem(ENTRA_TOKEN_KEY, "stale-token");

        render(
            <ConfigShim config={makeConfig("entra")}>
                <AuthProvider>
                    <AuthProbe />
                </AuthProvider>
            </ConfigShim>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("auth-loading")).toHaveTextContent("ready"),
        );
        expect(screen.getByTestId("is-auth")).toHaveTextContent("no");
        expect(window.localStorage.getItem(ENTRA_USER_KEY)).toBeNull();
        expect(window.localStorage.getItem(ENTRA_TOKEN_KEY)).toBeNull();
    });

    it("signOut clears entra state and redirects through the backend logout endpoint", async () => {
        const token = makeJwt({ oid: "o-9", preferred_username: "x@y.com" });
        window.location.hash = `#access_token=${token}`;

        render(
            <ConfigShim config={makeConfig("entra")}>
                <AuthProvider>
                    <AuthProbe />
                </AuthProvider>
            </ConfigShim>,
        );
        await waitFor(() =>
            expect(screen.getByTestId("is-auth")).toHaveTextContent("yes"),
        );

        await userEvent.click(screen.getByText("sign-out"));

        await waitFor(() =>
            expect(screen.getByTestId("is-auth")).toHaveTextContent("no"),
        );
        expect(window.localStorage.getItem(ENTRA_TOKEN_KEY)).toBeNull();
        expect(window.localStorage.getItem(ENTRA_USER_KEY)).toBeNull();
        // The backend constructs the Microsoft logout URL — frontend
        // just navigates there.  NEXT_PUBLIC_API_BASE_URL falls back to
        // localhost:3001 in tests where it's unset.
        expect(window.location.href).toMatch(/\/auth\/logout$/);
    });
});

describe("AuthContext: getAccessToken", () => {
    it("delegates to getBrowserAccessToken — returns the local token in local mode", async () => {
        // Integration test: AuthContext.getAccessToken just forwards
        // to auth-token.ts.  This pins the wiring.
        window.localStorage.setItem(LOCAL_TOKEN_KEY, "stored-local-token");
        window.localStorage.setItem("mike.config.authProvider", "local");

        render(
            <ConfigShim config={makeConfig("local")}>
                <AuthProvider>
                    <AuthProbe />
                </AuthProvider>
            </ConfigShim>,
        );

        await waitFor(() =>
            expect(screen.getByTestId("auth-loading")).toHaveTextContent("ready"),
        );
        await userEvent.click(screen.getByText("get-token"));

        await waitFor(() =>
            expect(screen.getByTestId("token")).toHaveTextContent(
                "stored-local-token",
            ),
        );
    });
});

describe("AuthContext: useAuth outside a provider", () => {
    it("throws a clear error", () => {
        function Bare() {
            useAuth();
            return null;
        }

        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        expect(() => render(<Bare />)).toThrow(
            /useAuth must be used within an AuthProvider/,
        );
        errSpy.mockRestore();
    });
});
