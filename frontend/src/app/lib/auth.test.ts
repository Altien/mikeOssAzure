import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// auth.ts resolves the Supabase client through @/app/lib/supabase, so swap it
// for a controllable auth mock before the module under test loads. The
// statically imported module below sees the default test env (Supabase URL and
// key set by vitest.config.mts), i.e. the supabase provider; the local
// provider is exercised through dynamic imports with a stubbed env.
const { supabaseAuthMock } = vi.hoisted(() => ({
    supabaseAuthMock: {
        signInWithPassword: vi.fn(),
        signUp: vi.fn(),
        getSession: vi.fn(),
        signOut: vi.fn(),
        updateUser: vi.fn(),
        mfa: {
            listFactors: vi.fn(),
            getAuthenticatorAssuranceLevel: vi.fn(),
            enroll: vi.fn(),
            challenge: vi.fn(),
            verify: vi.fn(),
            challengeAndVerify: vi.fn(),
            unenroll: vi.fn(),
        },
    },
}));
vi.mock("@/app/lib/supabase", () => ({
    getBrowserSupabase: () => ({ auth: supabaseAuthMock }),
}));

import {
    getAuthToken,
    getCurrentUser,
    localAuth,
    resolveBrowserAuthProvider,
    signInWithPassword,
    signOut,
    signUpWithPassword,
    updateEmail,
} from "./auth";

const authChangeDispatched = () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    return () =>
        expect(dispatchSpy).toHaveBeenCalledWith(
            expect.objectContaining({ type: "mike-auth-change" }),
        );
};

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.clearAllMocks();
});

describe("browser auth provider selection", () => {
    it("uses Supabase when the upstream browser credentials are configured", () => {
        expect(
            resolveBrowserAuthProvider({
                NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
                NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY: "publishable-key",
            }),
        ).toBe("supabase");
    });

    it("keeps pre-provider local installations working", () => {
        expect(resolveBrowserAuthProvider({})).toBe("local");
    });

    it("honors an explicit provider", () => {
        expect(
            resolveBrowserAuthProvider({
                NEXT_PUBLIC_MIKE_AUTH_PROVIDER: "supabase",
            }),
        ).toBe("supabase");
        expect(
            resolveBrowserAuthProvider({
                NEXT_PUBLIC_MIKE_AUTH_PROVIDER: "LOCAL",
            }),
        ).toBe("local");
    });

    it("rejects an invalid provider", () => {
        expect(() =>
            resolveBrowserAuthProvider({
                NEXT_PUBLIC_MIKE_AUTH_PROVIDER: "firebase",
            }),
        ).toThrow('Unsupported NEXT_PUBLIC_MIKE_AUTH_PROVIDER "firebase"');
    });
});

describe("supabase auth provider", () => {
    it("signInWithPassword maps the supabase session and notifies listeners", async () => {
        supabaseAuthMock.signInWithPassword.mockResolvedValue({
            data: {
                user: { id: "u1", email: "a@b.c", new_email: "new@b.c" },
                session: { access_token: "tok-1" },
            },
            error: null,
        });
        const expectDispatch = authChangeDispatched();

        const result = await signInWithPassword("a@b.c", "pw");

        expect(
            supabaseAuthMock.signInWithPassword,
        ).toHaveBeenCalledWith({ email: "a@b.c", password: "pw" });
        expect(result).toEqual({
            token: "tok-1",
            user: { id: "u1", email: "a@b.c", new_email: "new@b.c" },
        });
        expectDispatch();
    });

    it("signInWithPassword defaults missing email fields", async () => {
        supabaseAuthMock.signInWithPassword.mockResolvedValue({
            data: {
                user: { id: "u1" },
                session: { access_token: "tok-1" },
            },
            error: null,
        });

        const result = await signInWithPassword("a@b.c", "pw");

        expect(result.user).toEqual({ id: "u1", email: "", new_email: null });
    });

    it("signInWithPassword rethrows supabase errors", async () => {
        const failure = new Error("invalid credentials");
        supabaseAuthMock.signInWithPassword.mockResolvedValue({
            data: { user: null, session: null },
            error: failure,
        });

        await expect(signInWithPassword("a@b.c", "pw")).rejects.toBe(failure);
    });

    it("signInWithPassword rejects when no session comes back", async () => {
        supabaseAuthMock.signInWithPassword.mockResolvedValue({
            data: { user: { id: "u1" }, session: null },
            error: null,
        });

        await expect(signInWithPassword("a@b.c", "pw")).rejects.toThrow(
            "Unable to sign in",
        );
    });

    it("signUpWithPassword maps the new user and tolerates a missing session", async () => {
        supabaseAuthMock.signUp.mockResolvedValue({
            data: {
                user: { id: "u1", email: "a@b.c", new_email: null },
                session: null,
            },
            error: null,
        });
        const expectDispatch = authChangeDispatched();

        const result = await signUpWithPassword("a@b.c", "pw");

        expect(supabaseAuthMock.signUp).toHaveBeenCalledWith({
            email: "a@b.c",
            password: "pw",
        });
        // No session yet (email confirmation pending) means an empty token.
        expect(result).toEqual({
            token: "",
            user: { id: "u1", email: "a@b.c", new_email: null },
        });
        expectDispatch();
    });

    it("signUpWithPassword falls back to the submitted email", async () => {
        supabaseAuthMock.signUp.mockResolvedValue({
            data: {
                user: { id: "u1" },
                session: { access_token: "tok-1" },
            },
            error: null,
        });

        const result = await signUpWithPassword("a@b.c", "pw");

        expect(result).toEqual({
            token: "tok-1",
            user: { id: "u1", email: "a@b.c", new_email: null },
        });
    });

    it("signUpWithPassword rethrows errors and rejects a missing user", async () => {
        const failure = new Error("already registered");
        supabaseAuthMock.signUp.mockResolvedValue({
            data: { user: null, session: null },
            error: failure,
        });
        await expect(signUpWithPassword("a@b.c", "pw")).rejects.toBe(failure);

        supabaseAuthMock.signUp.mockResolvedValue({
            data: { user: null, session: null },
            error: null,
        });
        await expect(signUpWithPassword("a@b.c", "pw")).rejects.toThrow(
            "Unable to create account",
        );
    });

    it("getCurrentUser maps the active session user", async () => {
        supabaseAuthMock.getSession.mockResolvedValue({
            data: {
                session: {
                    access_token: "tok-1",
                    user: { id: "u1", email: "a@b.c" },
                },
            },
            error: null,
        });

        await expect(getCurrentUser()).resolves.toEqual({
            id: "u1",
            email: "a@b.c",
            new_email: null,
        });
    });

    it("getCurrentUser returns null when there is no usable session", async () => {
        supabaseAuthMock.getSession.mockResolvedValue({
            data: { session: null },
            error: null,
        });
        await expect(getCurrentUser()).resolves.toBeNull();

        supabaseAuthMock.getSession.mockResolvedValue({
            data: { session: null },
            error: new Error("refresh failed"),
        });
        await expect(getCurrentUser()).resolves.toBeNull();
    });

    it("signOut ends the local session scope and notifies listeners", async () => {
        supabaseAuthMock.signOut.mockResolvedValue({ error: null });
        const expectDispatch = authChangeDispatched();

        await signOut();

        expect(supabaseAuthMock.signOut).toHaveBeenCalledWith({
            scope: "local",
        });
        expectDispatch();

        const failure = new Error("sign out failed");
        supabaseAuthMock.signOut.mockResolvedValue({ error: failure });
        await expect(signOut()).rejects.toBe(failure);
    });

    it("updateEmail points the confirmation link back at /settings", async () => {
        supabaseAuthMock.updateUser.mockResolvedValue({
            data: { user: { id: "u1", email: "a@b.c", new_email: "new@b.c" } },
            error: null,
        });
        const expectDispatch = authChangeDispatched();

        const result = await updateEmail("new@b.c");

        expect(supabaseAuthMock.updateUser).toHaveBeenCalledWith(
            { email: "new@b.c" },
            { emailRedirectTo: `${window.location.origin}/settings` },
        );
        expect(result).toEqual({
            id: "u1",
            email: "a@b.c",
            new_email: "new@b.c",
        });
        expectDispatch();
    });

    it("updateEmail rethrows errors and rejects a missing user", async () => {
        const failure = new Error("email taken");
        supabaseAuthMock.updateUser.mockResolvedValue({
            data: { user: null },
            error: failure,
        });
        await expect(updateEmail("new@b.c")).rejects.toBe(failure);

        supabaseAuthMock.updateUser.mockResolvedValue({
            data: { user: null },
            error: null,
        });
        await expect(updateEmail("new@b.c")).rejects.toThrow(
            "Unable to update email",
        );
    });

    it("getAuthToken returns the session token or null", async () => {
        supabaseAuthMock.getSession.mockResolvedValue({
            data: { session: { access_token: "tok-1" } },
        });
        await expect(getAuthToken()).resolves.toBe("tok-1");

        supabaseAuthMock.getSession.mockResolvedValue({
            data: { session: null },
        });
        await expect(getAuthToken()).resolves.toBeNull();
    });

    it("delegates every mfa call to the supabase client", async () => {
        const { mfa } = supabaseAuthMock;
        mfa.listFactors.mockResolvedValue({ data: { all: [], totp: [] } });
        mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({
            data: { currentLevel: "aal1", nextLevel: "aal2" },
        });
        mfa.enroll.mockResolvedValue({ data: { id: "f1" } });
        mfa.challenge.mockResolvedValue({ data: { id: "c1" } });
        mfa.verify.mockResolvedValue({ data: null });
        mfa.challengeAndVerify.mockResolvedValue({ data: null });
        mfa.unenroll.mockResolvedValue({ data: null });

        await localAuth.mfa.listFactors();
        expect(mfa.listFactors).toHaveBeenCalled();

        await localAuth.mfa.getAuthenticatorAssuranceLevel();
        expect(mfa.getAuthenticatorAssuranceLevel).toHaveBeenCalled();

        // Enroll always pins the factor type to totp.
        await localAuth.mfa.enroll({ friendlyName: "Phone" });
        expect(mfa.enroll).toHaveBeenCalledWith({
            factorType: "totp",
            friendlyName: "Phone",
        });

        await localAuth.mfa.challenge({ factorId: "f1" });
        expect(mfa.challenge).toHaveBeenCalledWith({ factorId: "f1" });

        await localAuth.mfa.verify({
            factorId: "f1",
            challengeId: "c1",
            code: "123456",
        });
        expect(mfa.verify).toHaveBeenCalledWith({
            factorId: "f1",
            challengeId: "c1",
            code: "123456",
        });

        await localAuth.mfa.challengeAndVerify({ factorId: "f1", code: "1" });
        expect(mfa.challengeAndVerify).toHaveBeenCalledWith({
            factorId: "f1",
            code: "1",
        });

        await localAuth.mfa.unenroll({ factorId: "f1" });
        expect(mfa.unenroll).toHaveBeenCalledWith({ factorId: "f1" });
    });

    it("defaults missing mfa arguments to empty strings", async () => {
        const { mfa } = supabaseAuthMock;
        mfa.challenge.mockResolvedValue({ data: { id: "c1" } });
        mfa.verify.mockResolvedValue({ data: null });
        mfa.challengeAndVerify.mockResolvedValue({ data: null });
        mfa.unenroll.mockResolvedValue({ data: null });
        mfa.enroll.mockResolvedValue({ data: { id: "f1" } });

        await localAuth.mfa.enroll();
        expect(mfa.enroll).toHaveBeenCalledWith({
            factorType: "totp",
            friendlyName: undefined,
        });

        await localAuth.mfa.challenge();
        expect(mfa.challenge).toHaveBeenCalledWith({ factorId: "" });

        await localAuth.mfa.verify();
        expect(mfa.verify).toHaveBeenCalledWith({
            factorId: "",
            challengeId: "",
            code: "",
        });

        await localAuth.mfa.challengeAndVerify();
        expect(mfa.challengeAndVerify).toHaveBeenCalledWith({
            factorId: "",
            code: "",
        });

        await localAuth.mfa.unenroll();
        expect(mfa.unenroll).toHaveBeenCalledWith({ factorId: "" });
    });
});

// ---------------------------------------------------------------------------
// Local provider: same public surface, but backed by fetch against the Mike
// backend and a localStorage token instead of the Supabase client. Each test
// re-imports the module under NEXT_PUBLIC_MIKE_AUTH_PROVIDER=local so the
// module-level localAuth delegate and the provider checks resolve locally.
// ---------------------------------------------------------------------------

const fetchMock = vi.fn();

// Node >= 22.4 installs its own localStorage global that is undefined without
// --localstorage-file, shadowing jsdom's — stub an in-memory Storage instead.
const storageMock = () => {
    const map = new Map<string, string>();
    return {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => void map.set(key, value),
        removeItem: (key: string) => void map.delete(key),
        clear: () => map.clear(),
    };
};

const importLocalAuth = async () => {
    vi.stubEnv("NEXT_PUBLIC_MIKE_AUTH_PROVIDER", "local");
    vi.resetModules();
    return import("./auth");
};

const jsonResponse = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
        ...init,
    });

const lastFetchCall = () => {
    const call = fetchMock.mock.calls.at(-1);
    if (!call) throw new Error("fetch was not called");
    return { url: call[0] as string, init: call[1] as RequestInit };
};

describe("local auth provider", () => {
    beforeEach(() => {
        vi.stubGlobal("fetch", fetchMock);
        vi.stubGlobal("localStorage", storageMock());
    });

    it("signInWithPassword posts credentials, stores the token, and notifies", async () => {
        const auth = await importLocalAuth();
        fetchMock.mockResolvedValue(
            jsonResponse({ token: "tok-9", user: { id: "u1", email: "a@b.c" } }),
        );
        const expectDispatch = authChangeDispatched();

        const result = await auth.signInWithPassword("a@b.c", "pw");

        expect(result).toEqual({
            token: "tok-9",
            user: { id: "u1", email: "a@b.c" },
        });
        const { url, init } = lastFetchCall();
        expect(url).toBe("http://localhost:3001/user/auth/login");
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body as string)).toEqual({
            email: "a@b.c",
            password: "pw",
        });
        // No stored token yet, so the login request itself is anonymous.
        expect(
            (init.headers as Record<string, string>).Authorization,
        ).toBeUndefined();
        expect(window.localStorage.getItem("mike_auth_token")).toBe("tok-9");
        expectDispatch();
    });

    it("signUpWithPassword posts to the signup route and stores the session", async () => {
        const auth = await importLocalAuth();
        fetchMock.mockResolvedValue(
            jsonResponse({ token: "tok-8", user: { id: "u2", email: "b@c.d" } }),
        );

        await auth.signUpWithPassword("b@c.d", "pw");

        const { url, init } = lastFetchCall();
        expect(url).toBe("http://localhost:3001/user/auth/signup");
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body as string)).toEqual({
            email: "b@c.d",
            password: "pw",
        });
        expect(window.localStorage.getItem("mike_auth_token")).toBe("tok-8");
    });

    it("getStoredToken and getAuthToken read the stored local token", async () => {
        const auth = await importLocalAuth();

        expect(auth.getStoredToken()).toBeNull();
        await expect(auth.getAuthToken()).resolves.toBeNull();

        window.localStorage.setItem("mike_auth_token", "tok-7");

        expect(auth.getStoredToken()).toBe("tok-7");
        await expect(auth.getAuthToken()).resolves.toBe("tok-7");
    });

    it("getCurrentUser returns null without a stored token", async () => {
        const auth = await importLocalAuth();

        await expect(auth.getCurrentUser()).resolves.toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("getCurrentUser fetches the session with the bearer token", async () => {
        const auth = await importLocalAuth();
        window.localStorage.setItem("mike_auth_token", "tok-7");
        fetchMock.mockResolvedValue(
            jsonResponse({ user: { id: "u1", email: "a@b.c" } }),
        );

        await expect(auth.getCurrentUser()).resolves.toEqual({
            id: "u1",
            email: "a@b.c",
        });

        const { url, init } = lastFetchCall();
        expect(url).toBe("http://localhost:3001/user/auth/session");
        expect(init.headers).toMatchObject({
            Authorization: "Bearer tok-7",
        });
    });

    it("getCurrentUser clears the token when the server has no user", async () => {
        const auth = await importLocalAuth();
        window.localStorage.setItem("mike_auth_token", "tok-7");
        fetchMock.mockResolvedValue(jsonResponse({ user: null }));

        await expect(auth.getCurrentUser()).resolves.toBeNull();

        expect(window.localStorage.getItem("mike_auth_token")).toBeNull();
    });

    it("getCurrentUser clears the token on 401/403 and keeps it otherwise", async () => {
        const auth = await importLocalAuth();

        // 401 with a JSON detail body: token is dropped.
        window.localStorage.setItem("mike_auth_token", "tok-7");
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ detail: "expired" }, { status: 401 }),
        );
        await expect(auth.getCurrentUser()).resolves.toBeNull();
        expect(window.localStorage.getItem("mike_auth_token")).toBeNull();

        // 403 with a non-JSON body: falls back to the status text, token dropped.
        window.localStorage.setItem("mike_auth_token", "tok-7");
        fetchMock.mockResolvedValueOnce(
            new Response("nope", { status: 403, statusText: "Forbidden" }),
        );
        await expect(auth.getCurrentUser()).resolves.toBeNull();
        expect(window.localStorage.getItem("mike_auth_token")).toBeNull();

        // 500: not an auth failure, so the token survives.
        window.localStorage.setItem("mike_auth_token", "tok-7");
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ detail: "boom" }, { status: 500 }),
        );
        await expect(auth.getCurrentUser()).resolves.toBeNull();
        expect(window.localStorage.getItem("mike_auth_token")).toBe("tok-7");

        // A network-level failure is not an auth failure either.
        fetchMock.mockRejectedValueOnce(new Error("socket hangup"));
        await expect(auth.getCurrentUser()).resolves.toBeNull();
        expect(window.localStorage.getItem("mike_auth_token")).toBe("tok-7");
    });

    it("signOut posts logout, clears the token, and notifies", async () => {
        const auth = await importLocalAuth();
        window.localStorage.setItem("mike_auth_token", "tok-7");
        // The logout endpoint answers 204 No Content.
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
        const expectDispatch = authChangeDispatched();

        await auth.signOut();

        const { url, init } = lastFetchCall();
        expect(url).toBe("http://localhost:3001/user/auth/logout");
        expect(init.method).toBe("POST");
        expect(window.localStorage.getItem("mike_auth_token")).toBeNull();
        expectDispatch();
    });

    it("signOut still clears the token when the logout request fails", async () => {
        const auth = await importLocalAuth();
        window.localStorage.setItem("mike_auth_token", "tok-7");
        fetchMock.mockRejectedValue(new Error("offline"));

        await auth.signOut();

        expect(window.localStorage.getItem("mike_auth_token")).toBeNull();
    });

    it("updateEmail patches the email route and returns the user", async () => {
        const auth = await importLocalAuth();
        window.localStorage.setItem("mike_auth_token", "tok-7");
        fetchMock.mockResolvedValue(
            jsonResponse({
                user: { id: "u1", email: "a@b.c", pendingEmail: "new@b.c" },
            }),
        );

        const user = await auth.updateEmail("new@b.c");

        expect(user).toEqual({
            id: "u1",
            email: "a@b.c",
            pendingEmail: "new@b.c",
        });
        const { url, init } = lastFetchCall();
        expect(url).toBe("http://localhost:3001/user/auth/email");
        expect(init.method).toBe("PATCH");
        expect(JSON.parse(init.body as string)).toEqual({
            email: "new@b.c",
        });
    });

    it("localAuth.mfa.listFactors filters to verified totp factors", async () => {
        const auth = await importLocalAuth();
        fetchMock.mockResolvedValue(
            jsonResponse({
                factors: [
                    { id: "f1", factor_type: "totp", status: "verified" },
                    { id: "f2", factor_type: "totp", status: "unverified" },
                ],
                currentLevel: "aal1",
                nextLevel: "aal2",
            }),
        );

        const result = await auth.localAuth.mfa.listFactors();

        expect(lastFetchCall().url).toBe(
            "http://localhost:3001/user/mfa/status",
        );
        expect(result.error).toBeNull();
        expect(result.data.all).toHaveLength(2);
        expect(result.data.totp).toEqual([
            { id: "f1", factor_type: "totp", status: "verified" },
        ]);
    });

    it("localAuth.mfa.listFactors falls back to empty lists on failure", async () => {
        const auth = await importLocalAuth();
        fetchMock.mockResolvedValue(
            jsonResponse({ detail: "boom" }, { status: 500 }),
        );

        const result = await auth.localAuth.mfa.listFactors();

        expect(result.data).toEqual({ all: [], totp: [] });
        expect(result.error?.message).toBe("boom");
    });

    it("localAuth.mfa.getAuthenticatorAssuranceLevel maps the status levels", async () => {
        const auth = await importLocalAuth();
        fetchMock.mockResolvedValue(
            jsonResponse({
                factors: [],
                currentLevel: "aal2",
                nextLevel: "aal2",
            }),
        );

        const result =
            await auth.localAuth.mfa.getAuthenticatorAssuranceLevel();

        expect(result).toEqual({
            data: { currentLevel: "aal2", nextLevel: "aal2" },
            error: null,
        });

        fetchMock.mockResolvedValueOnce(
            jsonResponse({ detail: "boom" }, { status: 500 }),
        );
        const failed = await auth.localAuth.mfa.getAuthenticatorAssuranceLevel();
        expect(failed.data).toEqual({
            currentLevel: "aal1",
            nextLevel: "aal1",
        });
        expect(failed.error).not.toBeNull();
    });

    it("localAuth.mfa.enroll posts the friendly name", async () => {
        const auth = await importLocalAuth();
        const totp = { qr_code: "data:image/png;base64,x", secret: "S3CR3T" };
        fetchMock.mockResolvedValue(jsonResponse({ id: "f1", totp }));

        const result = await auth.localAuth.mfa.enroll({
            friendlyName: "Phone",
        });

        expect(result).toEqual({ data: { id: "f1", totp }, error: null });
        const { url, init } = lastFetchCall();
        expect(url).toBe("http://localhost:3001/user/mfa/enroll");
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body as string)).toEqual({
            friendlyName: "Phone",
        });

        fetchMock.mockResolvedValueOnce(jsonResponse({ id: "f2", totp }));
        await auth.localAuth.mfa.enroll();
        // undefined fields are dropped from the JSON payload entirely.
        expect(lastFetchCall().init.body).toBe("{}");
    });

    it("localAuth.mfa.enroll synthesizes an Error for non-Error failures", async () => {
        const auth = await importLocalAuth();
        fetchMock.mockRejectedValue("upstream exploded");

        const result = await auth.localAuth.mfa.enroll();

        expect(result.data).toEqual({
            id: "",
            totp: { qr_code: "", secret: "" },
        });
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error?.message).toBe("MFA request failed");
    });

    it("localAuth.mfa.challenge posts the factor id", async () => {
        const auth = await importLocalAuth();
        fetchMock.mockResolvedValue(
            jsonResponse({ id: "ch1", expires_at: "2026-08-13" }),
        );

        const result = await auth.localAuth.mfa.challenge({ factorId: "f1" });

        expect(result).toEqual({
            data: { id: "ch1", expires_at: "2026-08-13" },
            error: null,
        });
        const { url, init } = lastFetchCall();
        expect(url).toBe("http://localhost:3001/user/mfa/challenge");
        expect(JSON.parse(init.body as string)).toEqual({ factorId: "f1" });

        fetchMock.mockResolvedValueOnce(
            jsonResponse({ id: "ch2", expires_at: "" }),
        );
        await auth.localAuth.mfa.challenge();
        expect(lastFetchCall().init.body).toBe("{}");
    });

    it("localAuth.mfa.verify posts the full verification payload", async () => {
        const auth = await importLocalAuth();
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

        const result = await auth.localAuth.mfa.verify({
            factorId: "f1",
            challengeId: "ch1",
            code: "123456",
        });

        expect(result).toEqual({ data: null, error: null });
        const { url, init } = lastFetchCall();
        expect(url).toBe("http://localhost:3001/user/mfa/verify");
        expect(JSON.parse(init.body as string)).toEqual({
            factorId: "f1",
            challengeId: "ch1",
            code: "123456",
        });
    });

    it("localAuth.mfa.challengeAndVerify chains challenge into verify", async () => {
        const auth = await importLocalAuth();
        fetchMock
            .mockResolvedValueOnce(
                jsonResponse({ id: "ch1", expires_at: "2026-08-13" }),
            )
            .mockResolvedValueOnce(new Response(null, { status: 204 }));

        const result = await auth.localAuth.mfa.challengeAndVerify({
            factorId: "f1",
            code: "123456",
        });

        expect(result).toEqual({ data: null, error: null });
        // The verify call carries the challenge id from the first response.
        expect(
            JSON.parse(lastFetchCall().init.body as string),
        ).toEqual({
            factorId: "f1",
            challengeId: "ch1",
            code: "123456",
        });
    });

    it("localAuth.mfa.challengeAndVerify stops when the challenge fails", async () => {
        const auth = await importLocalAuth();
        fetchMock.mockResolvedValue(
            jsonResponse({ detail: "no factor" }, { status: 404 }),
        );

        const result = await auth.localAuth.mfa.challengeAndVerify({
            factorId: "f1",
            code: "123456",
        });

        expect(result.data).toBeNull();
        expect(result.error?.message).toBe("no factor");
        // Only the challenge call was made — never the verify.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("localAuth.mfa.unenroll posts the factor id", async () => {
        const auth = await importLocalAuth();
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

        const result = await auth.localAuth.mfa.unenroll({ factorId: "f1" });

        expect(result).toEqual({ data: null, error: null });
        const { url, init } = lastFetchCall();
        expect(url).toBe("http://localhost:3001/user/mfa/unenroll");
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body as string)).toEqual({ factorId: "f1" });
    });
});
