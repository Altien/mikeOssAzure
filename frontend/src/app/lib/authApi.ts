import {
    getCurrentUser,
    localAuth,
    setPassword,
    signInWithPassword,
    signOut,
    signUpWithPassword,
    updateEmail,
    type AuthUser as LocalAuthUser,
} from "@/app/lib/auth";

export interface AuthUser {
    id: string;
    email: string;
    pendingEmail: string | null;
    createdWithGoogle: boolean;
}

export interface MfaFactor {
    id: string;
    friendly_name?: string | null;
    factor_type: string;
    status?: string;
}

export class AuthApiError extends Error {
    status: number;
    code: string | null;

    constructor(status: number, code: string | null, message: string) {
        super(message);
        this.name = "AuthApiError";
        this.status = status;
        this.code = code;
    }
}

function mapLocalUser(user: LocalAuthUser): AuthUser {
    return {
        id: user.id,
        email: user.email,
        pendingEmail: user.pendingEmail ?? user.new_email ?? null,
        createdWithGoogle: false,
    };
}

function unsupported(feature: string): never {
    throw new AuthApiError(
        501,
        "local_auth_unsupported",
        `${feature} is unavailable with SQLite authentication.`,
    );
}

async function unwrapMfa<T>(
    result: Promise<{ data: T; error: Error | null }>,
): Promise<T> {
    const { data, error } = await result;
    if (error) throw error;
    return data;
}

export async function getAuthSession(): Promise<AuthUser | null> {
    const user = await getCurrentUser();
    return user ? mapLocalUser(user) : null;
}

export async function login(email: string, password: string) {
    const { user } = await signInWithPassword(email, password);
    return { user: mapLocalUser(user) };
}

export async function signup(email: string, password: string, _next: string) {
    const { user } = await signUpWithPassword(email, password);
    return {
        user: mapLocalUser(user),
        requiresEmailConfirmation: false,
    };
}

export async function startGoogleOAuth(_next: string) {
    unsupported("Google sign-in");
}

export async function exchangeAuthCode(_code: string) {
    unsupported("OAuth code exchange");
}

export async function requestPasswordReset(_email: string) {
    unsupported("Password reset");
}

export async function logout(_scope: "local" | "global" = "local") {
    await signOut();
}

export async function updateAuthEmail(email: string, _next: string) {
    return { user: mapLocalUser(await updateEmail(email)) };
}

export async function updateAuthPassword(password: string, _signOut = false) {
    return { user: mapLocalUser(await setPassword(password)) };
}

export async function listMfaFactors() {
    return unwrapMfa(localAuth.mfa.listFactors());
}

export async function getMfaAssurance() {
    return unwrapMfa(localAuth.mfa.getAuthenticatorAssuranceLevel());
}

export async function enrollMfa(friendlyName: string) {
    return unwrapMfa(
        localAuth.mfa.enroll({ factorType: "totp", friendlyName }),
    );
}

export async function challengeMfa(factorId: string) {
    return unwrapMfa(localAuth.mfa.challenge({ factorId }));
}

export async function verifyMfa(
    factorId: string,
    challengeId: string,
    code: string,
) {
    return unwrapMfa(localAuth.mfa.verify({ factorId, challengeId, code }));
}

export async function challengeAndVerifyMfa(factorId: string, code: string) {
    return unwrapMfa(localAuth.mfa.challengeAndVerify({ factorId, code }));
}

export async function unenrollMfa(factorId: string) {
    return unwrapMfa(localAuth.mfa.unenroll({ factorId }));
}

export function clearLegacyBrowserAuthStorage() {
    if (typeof window === "undefined") return;
    for (const storage of [window.localStorage, window.sessionStorage]) {
        for (let index = storage.length - 1; index >= 0; index -= 1) {
            const key = storage.key(index);
            if (key && /(?:^|-)auth-token(?:$|-)|supabase.*auth/i.test(key)) {
                storage.removeItem(key);
            }
        }
    }
}
