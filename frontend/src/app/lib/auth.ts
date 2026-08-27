import { getBrowserSupabase } from "@/app/lib/supabase";

const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
const TOKEN_KEY = "mike_auth_token";

export type BrowserAuthProvider = "supabase" | "local";

export function resolveBrowserAuthProvider(
    env: Record<string, string | undefined> = process.env,
): BrowserAuthProvider {
    const configured = env.NEXT_PUBLIC_MIKE_AUTH_PROVIDER?.trim().toLowerCase();
    if (configured) {
        if (configured === "supabase" || configured === "local") {
            return configured;
        }
        throw new Error(
            `Unsupported NEXT_PUBLIC_MIKE_AUTH_PROVIDER "${configured}". Expected supabase or local.`,
        );
    }
    // Compatibility for the local profile that predates provider selection.
    if (
        !env.NEXT_PUBLIC_SUPABASE_URL?.trim() &&
        !env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY?.trim()
    ) {
        return "local";
    }
    return "supabase";
}

function usesSupabaseAuth(): boolean {
    return resolveBrowserAuthProvider() === "supabase";
}

function dispatchAuthChange(): void {
    if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("mike-auth-change"));
    }
}

export type AuthUser = {
    id: string;
    email: string;
    pendingEmail?: string | null;
    new_email?: string | null;
};

type AuthResponse = {
    token: string;
    user: AuthUser;
};

class AuthRequestError extends Error {
    status: number | null;

    constructor(message: string, status: number | null) {
        super(message);
        this.name = "AuthRequestError";
        this.status = status;
    }
}

async function authRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const token = getStoredToken();
    const response = await fetch(`${API_BASE}${path}`, {
        cache: "no-store",
        ...init,
        headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(init?.headers ?? {}),
        },
    });
    if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new AuthRequestError(
            body?.detail || response.statusText,
            response.status,
        );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
}

export function getStoredToken(): string | null {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(TOKEN_KEY);
}

function clearStoredToken(dispatchChange = true) {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(TOKEN_KEY);
    if (dispatchChange) {
        window.dispatchEvent(new Event("mike-auth-change"));
    }
}

function storeSession(response: AuthResponse): AuthResponse {
    if (typeof window !== "undefined") {
        window.localStorage.setItem(TOKEN_KEY, response.token);
        window.dispatchEvent(new Event("mike-auth-change"));
    }
    return response;
}

export async function signInWithPassword(email: string, password: string) {
    if (usesSupabaseAuth()) {
        const { data, error } = await getBrowserSupabase().auth.signInWithPassword({
            email,
            password,
        });
        if (error) throw error;
        if (!data.user || !data.session) throw new Error("Unable to sign in");
        dispatchAuthChange();
        return {
            token: data.session.access_token,
            user: {
                id: data.user.id,
                email: data.user.email ?? "",
                new_email: data.user.new_email ?? null,
            },
        };
    }
    return storeSession(
        await authRequest<AuthResponse>("/user/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password }),
        }),
    );
}

export async function signUpWithPassword(email: string, password: string) {
    if (usesSupabaseAuth()) {
        const { data, error } = await getBrowserSupabase().auth.signUp({
            email,
            password,
        });
        if (error) throw error;
        if (!data.user) throw new Error("Unable to create account");
        dispatchAuthChange();
        return {
            token: data.session?.access_token ?? "",
            user: {
                id: data.user.id,
                email: data.user.email ?? email,
                new_email: data.user.new_email ?? null,
            },
        };
    }
    return storeSession(
        await authRequest<AuthResponse>("/user/auth/signup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password }),
        }),
    );
}

export async function getCurrentUser(): Promise<AuthUser | null> {
    if (usesSupabaseAuth()) {
        const {
            data: { session },
            error,
        } = await getBrowserSupabase().auth.getSession();
        if (error || !session?.user) return null;
        return {
            id: session.user.id,
            email: session.user.email ?? "",
            new_email: session.user.new_email ?? null,
        };
    }
    if (!getStoredToken()) return null;
    try {
        const response = await authRequest<{ user: AuthUser | null }>(
            "/user/auth/session",
        );
        if (!response.user) {
            clearStoredToken(false);
        }
        return response.user;
    } catch (error) {
        if (
            error instanceof AuthRequestError &&
            (error.status === 401 || error.status === 403)
        ) {
            clearStoredToken(false);
        }
        return null;
    }
}

export async function signOut() {
    if (usesSupabaseAuth()) {
        const { error } = await getBrowserSupabase().auth.signOut({
            scope: "local",
        });
        if (error) throw error;
        dispatchAuthChange();
        return;
    }
    await authRequest<void>("/user/auth/logout", { method: "POST" }).catch(
        () => undefined,
    );
    clearStoredToken();
}

export async function updateEmail(email: string): Promise<AuthUser> {
    if (usesSupabaseAuth()) {
        const redirectTo =
            typeof window === "undefined"
                ? undefined
                : `${window.location.origin}/settings`;
        const { data, error } = await getBrowserSupabase().auth.updateUser(
            { email },
            redirectTo ? { emailRedirectTo: redirectTo } : undefined,
        );
        if (error) throw error;
        if (!data.user) throw new Error("Unable to update email");
        dispatchAuthChange();
        return {
            id: data.user.id,
            email: data.user.email ?? "",
            new_email: data.user.new_email ?? null,
        };
    }
    const response = await authRequest<{ user: AuthUser }>("/user/auth/email", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
    });
    return response.user;
}

/**
 * Set a password on an account that was created without one.
 *
 * This only arises for federated (Google) sign-ups, which the local auth
 * provider does not offer — every local account is created with a password.
 * The local branch therefore rejects rather than calling an endpoint that
 * does not exist; the UI that reaches here is gated on `createdWithGoogle`,
 * which is always false under local auth.
 */
export async function setPassword(password: string): Promise<AuthUser> {
    if (usesSupabaseAuth()) {
        const { data, error } = await getBrowserSupabase().auth.updateUser({
            password,
        });
        if (error) throw error;
        if (!data.user) throw new Error("Unable to set password");
        dispatchAuthChange();
        return {
            id: data.user.id,
            email: data.user.email ?? "",
            new_email: data.user.new_email ?? null,
        };
    }
    throw new Error(
        "Setting a password is not supported by the local auth provider.",
    );
}

export async function getAuthToken(): Promise<string | null> {
    if (usesSupabaseAuth()) {
        const {
            data: { session },
        } = await getBrowserSupabase().auth.getSession();
        return session?.access_token ?? null;
    }
    return getStoredToken();
}

type MfaFactor = {
    id: string;
    friendly_name?: string | null;
    factor_type: string;
    status?: string;
};

type MfaStatusResponse = {
    factors: MfaFactor[];
    currentLevel: "aal1" | "aal2";
    nextLevel: "aal1" | "aal2";
};

type MfaResult<T> = {
    data: T;
    error: (Error & { code?: string }) | null;
};

async function mfaCall<T>(
    fn: () => Promise<T>,
    fallback: T,
): Promise<MfaResult<T>> {
    try {
        return { data: await fn(), error: null };
    } catch (error) {
        return {
            data: fallback,
            error:
                error instanceof Error
                    ? (error as Error & { code?: string })
                    : (Object.assign(new Error("MFA request failed"), {}) as Error & {
                          code?: string;
                      }),
        };
    }
}

async function fetchMfaStatus(): Promise<MfaStatusResponse> {
    return authRequest<MfaStatusResponse>("/user/mfa/status");
}

const localAuthClient = {
    mfa: {
        async listFactors(): Promise<
            MfaResult<{ all: MfaFactor[]; totp: MfaFactor[] }>
        > {
            return mfaCall(
                async () => {
                    const status = await fetchMfaStatus();
                    return {
                        all: status.factors,
                        totp: status.factors.filter(
                            (factor) => factor.status === "verified",
                        ),
                    };
                },
                { all: [], totp: [] },
            );
        },
        async getAuthenticatorAssuranceLevel(): Promise<
            MfaResult<{
                currentLevel: "aal1" | "aal2";
                nextLevel: "aal1" | "aal2";
            }>
        > {
            return mfaCall(
                async () => {
                    const status = await fetchMfaStatus();
                    return {
                        currentLevel: status.currentLevel,
                        nextLevel: status.nextLevel,
                    };
                },
                { currentLevel: "aal1" as const, nextLevel: "aal1" as const },
            );
        },
        async enroll(args?: {
            factorType?: string;
            friendlyName?: string;
        }): Promise<
            MfaResult<{ id: string; totp: { qr_code: string; secret: string } }>
        > {
            return mfaCall(
                () =>
                    authRequest<{
                        id: string;
                        totp: { qr_code: string; secret: string };
                    }>("/user/mfa/enroll", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            friendlyName: args?.friendlyName,
                        }),
                    }),
                { id: "", totp: { qr_code: "", secret: "" } },
            );
        },
        async challenge(args?: {
            factorId: string;
        }): Promise<MfaResult<{ id: string; expires_at: string }>> {
            return mfaCall(
                () =>
                    authRequest<{ id: string; expires_at: string }>(
                        "/user/mfa/challenge",
                        {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ factorId: args?.factorId }),
                        },
                    ),
                { id: "", expires_at: "" },
            );
        },
        async verify(args?: {
            factorId: string;
            challengeId?: string;
            code: string;
        }): Promise<MfaResult<null>> {
            return mfaCall(async () => {
                await authRequest<void>("/user/mfa/verify", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        factorId: args?.factorId,
                        challengeId: args?.challengeId,
                        code: args?.code,
                    }),
                });
                return null;
            }, null);
        },
        async challengeAndVerify(args?: {
            factorId: string;
            code: string;
        }): Promise<MfaResult<null>> {
            const challenge = await localAuthClient.mfa.challenge({
                factorId: args?.factorId ?? "",
            });
            if (challenge.error) return { data: null, error: challenge.error };
            return localAuthClient.mfa.verify({
                factorId: args?.factorId ?? "",
                challengeId: challenge.data.id,
                code: args?.code ?? "",
            });
        },
        async unenroll(args?: { factorId: string }): Promise<MfaResult<null>> {
            return mfaCall(async () => {
                await authRequest<void>("/user/mfa/unenroll", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ factorId: args?.factorId }),
                });
                return null;
            }, null);
        },
    },
};

const supabaseAuthClient = {
    mfa: {
        listFactors: () => getBrowserSupabase().auth.mfa.listFactors(),
        getAuthenticatorAssuranceLevel: () =>
            getBrowserSupabase().auth.mfa.getAuthenticatorAssuranceLevel(),
        enroll: (args?: { factorType?: string; friendlyName?: string }) =>
            getBrowserSupabase().auth.mfa.enroll({
                factorType: "totp",
                friendlyName: args?.friendlyName,
            }),
        challenge: (args?: { factorId: string }) =>
            getBrowserSupabase().auth.mfa.challenge({
                factorId: args?.factorId ?? "",
            }),
        verify: (args?: {
            factorId: string;
            challengeId?: string;
            code: string;
        }) =>
            getBrowserSupabase().auth.mfa.verify({
                factorId: args?.factorId ?? "",
                challengeId: args?.challengeId ?? "",
                code: args?.code ?? "",
            }),
        challengeAndVerify: (args?: { factorId: string; code: string }) =>
            getBrowserSupabase().auth.mfa.challengeAndVerify({
                factorId: args?.factorId ?? "",
                code: args?.code ?? "",
            }),
        unenroll: (args?: { factorId: string }) =>
            getBrowserSupabase().auth.mfa.unenroll({
                factorId: args?.factorId ?? "",
            }),
    },
};

// Retain the historical export name so existing feature UI stays unchanged;
// the object now delegates to the configured auth provider.
export const localAuth: typeof localAuthClient = (
    usesSupabaseAuth() ? supabaseAuthClient : localAuthClient
) as typeof localAuthClient;
