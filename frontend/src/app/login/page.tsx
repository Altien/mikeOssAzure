"use client";
import { useConfig, useConfigLoading } from "@/app/contexts/ConfigContext";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseClient } from "@/app/lib/supabase";
import { Input } from "@/app/components/ui/input";
import { PillButton } from "@/app/components/ui/pill-button";
import Link from "next/link";
import { SiteLogo } from "@/app/components/site-logo";
import { useAuth } from "@/app/contexts/AuthContext";
import { cn } from "@/app/lib/utils";
import {
    authGlassCardClassName,
    authInputClassName,
} from "@/app/components/auth/authStyles";
import { knownErrorCodeMessage } from "@/app/lib/userFacingError";
import { AuthDivider } from "@/app/components/auth/AuthDivider";
import { GoogleAuthButton } from "@/app/components/auth/GoogleAuthButton";
import { FieldLabel } from "@/app/components/ui/form-field";

const LOGIN_ERROR_MESSAGES = {
    invalid_credentials: "The email or password is incorrect.",
    email_not_confirmed: "Confirm your email address before logging in.",
} as const;

export default function LoginPage() {
    const router = useRouter();
    const { isAuthenticated, authLoading, signInLocal } = useAuth();
    const config = useConfig();
    const configLoading = useConfigLoading();
    const isEntraAuth = config.authProvider === "entra";
    const isLocalAuth = config.authProvider === "local";
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!authLoading && isAuthenticated) {
            router.replace("/onboarding/profile");
        }
    }, [authLoading, isAuthenticated, router]);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const oauthError = params.get("error");
        if (oauthError) {
            setError(oauthError);
            return;
        }
        // Session-expired arrives via `?reason=session-expired` from the
        // 401 interceptor in mikeApi.ts / lib/auth-token.ts.  Show a
        // friendly nudge rather than the raw query value.
        const reason = params.get("reason");
        if (reason === "session-expired") {
            setError("Your session has expired. Please sign in again.");
        }
    }, []);

    const handleMicrosoftLogin = async () => {
        const apiBase =
            (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001") +
            "/api";
        const returnUrl = encodeURIComponent(
            window.location.origin + "/assistant",
        );
        window.location.href = `${apiBase}/auth/select-provider?returnUrl=${returnUrl}&selectAccount=true`;
    };

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        try {
            if (isLocalAuth) {
                await signInLocal(email);
                router.push("/assistant");
                return;
            }
            const { error } = await getSupabaseClient().auth.signInWithPassword({
                email,
                password,
            });

            if (error) throw error;

            router.push("/onboarding/profile");
        } catch (error: unknown) {
            setError(
                knownErrorCodeMessage(
                    error,
                    LOGIN_ERROR_MESSAGES,
                    "Unable to log in right now. Please try again.",
                ),
            );
        } finally {
            setLoading(false);
        }
    };

    if (configLoading) return null;
    return (
        <div className="relative flex min-h-dvh items-center justify-center bg-gray-50/80 px-6 py-10">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="lg" asLink />
            </div>
            <div className="w-full max-w-md">
                {/* Login Form */}
                <div className={cn(authGlassCardClassName, "mb-4")}>
                    <h2 className="mb-6 text-left text-2xl font-medium font-serif text-gray-950">
                        Log In
                    </h2>
                    {isEntraAuth ? <div className="space-y-4">
                        {error && <p role="alert">{error}</p>}
                        <PillButton tone="black" onClick={handleMicrosoftLogin}>Sign in with Microsoft</PillButton>
                    </div> : <form onSubmit={handleLogin} className="space-y-4">
                        <div>
                            <FieldLabel htmlFor="email">
                                Email
                            </FieldLabel>
                            <Input
                                id="email"
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                required
                                className={`w-full ${authInputClassName}`}
                            />
                        </div>

                        {!isLocalAuth && <div>
                            <div className="mb-2 flex items-center justify-between gap-3">
                                <label
                                    htmlFor="password"
                                    className="block text-sm font-medium text-gray-700"
                                >
                                    Password
                                </label>
                                <Link
                                    href="/forgot-password"
                                    className="text-xs font-medium text-gray-500 transition-colors hover:text-gray-950"
                                >
                                    Forgot password?
                                </Link>
                            </div>
                            <Input
                                id="password"
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                                className={`w-full ${authInputClassName}`}
                            />
                        </div>}

                        {error && (
                            <div className="text-red-600 text-sm bg-red-50 p-3 rounded">
                                {error}
                            </div>
                        )}

                        <div className="pt-2">
                            <PillButton
                                type="submit"
                                tone="black"
                                size="normal"
                                disabled={loading}
                                className="w-full"
                            >
                                {loading ? "Logging in..." : isLocalAuth ? "Continue locally" : "Log in"}
                            </PillButton>
                        </div>
                        {!isLocalAuth && <><AuthDivider /><GoogleAuthButton onError={setError} disabled={loading} onLoadingChange={setLoading} /></>}
                    </form>}
                </div>
                <div className="text-center text-sm text-gray-500">
                    Don&apos;t have an account?{" "}
                    <Link
                        href="/signup"
                        className="font-medium transition-colors hover:text-gray-950"
                    >
                        Sign up
                    </Link>
                </div>
            </div>
        </div>
    );
}
