"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { login, loginLocal } from "@/app/lib/authApi";
import { useConfig } from "@/app/contexts/ConfigContext";
import { completeUserOnboarding, getUserProfile } from "@/app/lib/mikeApi";
import { InputUI } from "@/shared/ui/InputUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import Link from "next/link";
import { SiteLogo } from "@/app/components/site-logo";
import { useAuth } from "@/app/contexts/AuthContext";
import { cn } from "@/app/lib/utils";
import {
    authGlassCardUIClassName,
    authInputUIClassName,
} from "@/shared/ui/AuthStylesUI";
import { AuthDividerUI } from "@/shared/ui/AuthDividerUI";
import { SsoAuthButton } from "@/app/components/auth/SsoAuthButton";
import { GoogleAuthButton } from "@/app/components/auth/GoogleAuthButton";
import { FieldLabel } from "@/app/components/ui/form-field";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { noticeActionClassName } from "@/shared/ui/NoticeCardUI";
import {
    describeError,
    supportMailtoFor,
    type UserFacingError,
} from "@/app/lib/userFacingError";
import {
    AUTH_ERROR_MESSAGES,
    TOO_MANY_ATTEMPTS_MESSAGE,
    authMessages,
} from "@/app/lib/authMessages";

/**
 * The shared auth table (`@/app/lib/authMessages`) with this screen's
 * deltas. Anything not listed falls through to `describeError`, which
 * classifies by status (429, 5xx) or by the failure itself (offline,
 * connection dropped), so no login failure can collapse into "please try
 * again" without saying what happened.
 */
const LOGIN_ERROR_MESSAGES = authMessages({
    // Same text as invalid_credentials: saying "no such account" would let
    // anyone test which addresses are registered.
    user_not_found: AUTH_ERROR_MESSAGES.invalid_credentials,
    // Here the account exists; it is this sign-in route that is closed.
    signup_disabled: "This account can't be used to log in.",
    validation_failed: "Enter your email address and password.",
    invalid_request: "Enter your email address and password.",
    request_timeout: "The login request timed out. Try again.",
});

/** The title `notifyError` gives the same warning away from this page. */
const SESSION_WARNING_TITLE = "Couldn't check your session";

/** Classify a login failure into text a person can act on. */
function describeLoginError(error: unknown): UserFacingError {
    const described = describeError(error, {
        action: "log in",
        codeMessages: LOGIN_ERROR_MESSAGES,
        fallback: "Unable to log in right now. Try again.",
    });
    // A 429 without a GoTrue code still means "you tried too often".
    return described.kind === "rate_limited"
        ? { ...described, message: TOO_MANY_ATTEMPTS_MESSAGE }
        : described;
}



// Upstream desktop 89dc8323 uses Dev's local cookie sessions; no GoTrue
// passwords or provider secrets cross this bridge.
type GuestCredentials = { email: string };
declare global {
  interface Window {
    mikeDesktop?: { guestCredentials?: () => Promise<GuestCredentials | null> };
  }
}

export default function LoginPage() {
    const router = useRouter();
    const config = useConfig();
    const {
        isAuthenticated,
        authLoading,
        authError,
        refreshSession,
        retrySession,
    } = useAuth();
    const [guest, setGuest] = useState<GuestCredentials | null>(null);
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<UserFacingError | null>(null);
    const [retryingSession, setRetryingSession] = useState(false);
    // The session warning is not about the form: a failed Retry is reported
    // in its place rather than as a sign-in error.
    const [sessionError, setSessionError] = useState<UserFacingError | null>(null);
    const [sessionWarningDismissed, setSessionWarningDismissed] = useState(false);
    const [shownAuthError, setShownAuthError] = useState(authError);
    if (shownAuthError !== authError) {
        // A new failure is a new warning, even after the last was dismissed.
        setShownAuthError(authError);
        setSessionError(null);
        setSessionWarningDismissed(false);
    }
    const [loginMode, setLoginMode] = useState<"account" | "guest" | null>(null);

    useEffect(() => {
        if (!authLoading && isAuthenticated) {
            router.replace("/onboarding/profile");
        }
    }, [authLoading, isAuthenticated, router]);

    useEffect(() => {
        let cancelled = false;
        if (config.authProvider !== "local") return;
        window.mikeDesktop?.guestCredentials?.().then((value) => {
            if (!cancelled && value?.email) setGuest(value);
        }).catch(() => {});
        return () => { cancelled = true; };
    }, [config.authProvider]);

    const handleGuestLogin = async () => {
        if (!guest || config.authProvider !== "local") return;
        setLoginMode("guest");
        setLoading(true); setError(null);
        try {
            await loginLocal(guest.email);
            const profile = await getUserProfile();
            if (!profile.onboardingComplete) await completeUserOnboarding();
            await refreshSession();
            router.push("/assistant");
        } catch (caught) {
            setError(describeError(caught, { action: "open your local workspace", fallback: "Unable to open the local workspace. Try again." }));
        } finally { setLoading(false); }
    };

    const submitLogin = async () => {
        setLoginMode("account");
        setLoading(true);
        setError(null);

        try {
            if (config.authProvider === "local") await loginLocal(email);
            else if (config.authProvider === "supabase") await login(email, password);
            else throw new Error("Use Microsoft sign-in for this deployment.");
            await refreshSession();
            router.push("/onboarding/profile");
        } catch (error: unknown) {
            setError(describeLoginError(error));
        } finally {
            setLoading(false);
        }
    };

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        await submitLogin();
    };

    const handleRetrySession = async () => {
        setRetryingSession(true);
        setSessionError(null);
        try {
            await retrySession();
        } catch (caught: unknown) {
            // The Retry button failing silently is what made the original
            // session error look permanent; say so instead.
            setSessionError(
                describeError(caught, {
                    action: "restore your session",
                    fallback: "Unable to restore your session. Try again.",
                }),
            );
            setSessionWarningDismissed(false);
        } finally {
            setRetryingSession(false);
        }
    };

    // One warning at a time: the form's own failure first, then the session's.
    const sessionWarningOpen =
        !error && !!authError && !sessionWarningDismissed;
    const shownError = error ?? (sessionWarningOpen ? sessionError : null);
    const retryAction = error
        ? error.retryable && loginMode
            ? {
                  label: "Retry",
                  onClick: () =>
                      void (loginMode === "guest"
                          ? handleGuestLogin()
                          : submitLogin()),
                  disabled: loading,
              }
            : undefined
        : sessionWarningOpen
          ? {
                label: retryingSession ? "Retrying..." : "Retry",
                onClick: () => void handleRetrySession(),
                disabled: retryingSession,
            }
          : undefined;

    return (
        <div className="relative flex min-h-dvh items-center justify-center bg-gray-50/80 px-6 py-10">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="lg" asLink />
            </div>
            <div className="w-full max-w-md">
                {/* Login Form */}
                <div className={cn(authGlassCardUIClassName, "mb-4")}>
                    <h2 className="mb-6 text-left text-2xl font-medium font-serif text-gray-950">
                        {guest ? "Your workspace on this Mac" : "Log In"}
                    </h2>
                    {guest && <div className="mb-6 space-y-3">
                        <p className="text-sm text-muted-foreground">Start without a cloud account. Your work is saved on this Mac.</p>
                        <PillButtonUI type="button" tone="black" size="normal" className="w-full"
                            onClick={handleGuestLogin} disabled={loading}>
                            {loading ? "Opening workspace…" : "Continue on this Mac"}
                        </PillButtonUI>
                    </div>}
                    <details open={!guest}>
                        <summary hidden={!guest} className="mb-4 cursor-pointer text-sm text-muted-foreground">
                            Use a separate local account
                        </summary>
                    <form onSubmit={handleLogin} className="space-y-4">
                        {config.authProvider !== "entra" && <div>
                            <FieldLabel htmlFor="email">Email</FieldLabel>
                            <InputUI
                                id="email"
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                required
                                className={`w-full ${authInputUIClassName}`}
                            />
                        </div>}

                        {config.authProvider === "supabase" && <div>
                            <div className="flex items-start justify-between gap-3">
                                <FieldLabel htmlFor="password">
                                    Password
                                </FieldLabel>
                                <Link
                                    href="/forgot-password"
                                    className="text-xs font-medium text-gray-500 transition-colors hover:text-gray-950"
                                >
                                    Forgot password?
                                </Link>
                            </div>
                            <InputUI
                                id="password"
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                                className={`w-full ${authInputUIClassName}`}
                            />
                        </div>}

                        {config.authProvider !== "entra" && <div className="pt-2">
                            <PillButtonUI
                                type="submit"
                                tone="black"
                                size="normal"
                                disabled={loading}
                                className="w-full"
                            >
                                {loading ? "Logging in..." : "Log in"}
                            </PillButtonUI>
                        </div>}
                        {config.authProvider === "entra" && <PillButtonUI
                            type="button" tone="black" size="normal" className="w-full"
                            onClick={() => {
                                const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
                                const next = new URL("/onboarding/profile", window.location.origin).toString();
                                window.location.assign(`${base}/api/auth/login-provider/microsoft?returnUrl=${encodeURIComponent(next)}`);
                            }}
                        >Sign in with Microsoft</PillButtonUI>}
                        {config.authProvider === "supabase" && <><AuthDividerUI />
                        <GoogleAuthButton
                            onError={(nextError) => { setLoginMode(null); setError(nextError); }}
                            disabled={loading}
                            onLoadingChange={setLoading}
                        />
                        <SsoAuthButton disabled={loading} /></>}
                    </form>
                    </details>
                </div>
                {config.authProvider === "supabase" && <div className="text-center text-sm text-gray-500">
                    Don&apos;t have an account?{" "}
                    <Link
                        href="/signup"
                        className="font-medium transition-colors hover:text-gray-950"
                    >
                        Sign up
                    </Link>
                </div>}
            </div>
            <WarningPopup
                open={!!error || sessionWarningOpen}
                onClose={() => {
                    if (error) setError(null);
                    else setSessionWarningDismissed(true);
                }}
                title={shownError ? shownError.title : SESSION_WARNING_TITLE}
                message={shownError ? shownError.message : authError}
                actions={
                    shownError?.supportable ? (
                        <a
                            href={supportMailtoFor(
                                shownError,
                                "Failed to log in.",
                            )}
                            className={noticeActionClassName(
                                retryAction ? "secondary" : "primary",
                            )}
                        >
                            Contact support
                        </a>
                    ) : undefined
                }
                primaryAction={retryAction}
            />
        </div>
    );
}
