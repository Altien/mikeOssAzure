"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { login, loginLocal } from "@/app/lib/authApi";
import { useConfig } from "@/app/contexts/ConfigContext";
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
import { knownErrorCodeMessage } from "@/app/lib/userFacingError";

const LOGIN_ERROR_MESSAGES = {
    invalid_credentials: "The email or password is incorrect.",
    email_not_confirmed: "Confirm your email address before logging in.",
} as const;

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
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!authLoading && isAuthenticated) {
            router.replace("/onboarding/profile");
        }
    }, [authLoading, isAuthenticated, router]);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        try {
            if (config.authProvider === "local") await loginLocal(email);
            else if (config.authProvider === "supabase") await login(email, password);
            else throw new Error("Use Microsoft sign-in for this deployment.");
            await refreshSession();
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

    return (
        <div className="relative flex min-h-dvh items-center justify-center bg-gray-50/80 px-6 py-10">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="lg" asLink />
            </div>
            <div className="w-full max-w-md">
                {/* Login Form */}
                <div className={cn(authGlassCardUIClassName, "mb-4")}>
                    <h2 className="mb-6 text-left text-2xl font-medium font-serif text-gray-950">
                        Log In
                    </h2>
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

                        {(error || authError) && (
                            <div className="text-red-600 text-sm bg-red-50 p-3 rounded">
                                {error ?? authError}
                                {!error && authError && (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            void retrySession().catch(() => {})
                                        }
                                        className="ml-2 underline underline-offset-2"
                                    >
                                        Retry
                                    </button>
                                )}
                            </div>
                        )}

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
                            onError={setError}
                            disabled={loading}
                            onLoadingChange={setLoading}
                        />
                        <SsoAuthButton disabled={loading} /></>}
                    </form>
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
        </div>
    );
}
