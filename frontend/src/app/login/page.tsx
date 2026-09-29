"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
// Upstream divergence (OSS-6, auth; decision 8): upstream's page design is
// adopted, but sign-in follows dev's runtime auth mode from /config —
// "entra" shows a Microsoft sign-in button (backend-driven OIDC redirect),
// "local" signs in by email only, and "supabase" keeps upstream's
// email/password flow through the lazy supabase client.
import { getSupabaseClient } from "@/app/lib/supabase";
import { useConfig } from "@/app/contexts/ConfigContext";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import Link from "next/link";
import { SiteLogo } from "@/app/components/site-logo";
import { useAuth } from "@/app/contexts/AuthContext";

const authGlassCardClassName =
    "rounded-2xl border border-white/70 bg-white/72 p-8 shadow-[0_4px_14px_rgba(15,23,42,0.045),inset_0_1px_0_rgba(255,255,255,0.86),inset_0_-8px_18px_rgba(255,255,255,0.12)] backdrop-blur-2xl";
const authInputClassName =
    "rounded-lg border border-transparent bg-gray-100 px-3 shadow-none focus-visible:border-gray-200 focus-visible:ring-2 focus-visible:ring-gray-300/45";
const authToggleClassName =
    "flex gap-1 rounded-full bg-gray-200 p-1 text-xs font-medium";
const authToggleActiveClassName =
    "inline-flex h-6 items-center rounded-full border border-white/80 bg-white/86 px-3 text-gray-900 shadow-[0_2px_7px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-3px_7px_rgba(229,231,235,0.32)] backdrop-blur-xl";
const authToggleInactiveClassName =
    "inline-flex h-6 items-center rounded-full border border-transparent px-3 text-gray-500 transition-colors hover:bg-white/38 hover:text-gray-900";

export default function LoginPage() {
    const router = useRouter();
    const config = useConfig();
    const isEntraAuth = config.authProvider === "entra";
    const isLocalAuth = config.authProvider === "local";
    const { isAuthenticated, authLoading, signInLocal } = useAuth();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!authLoading && isAuthenticated) {
            router.replace("/assistant");
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

            const supabase = getSupabaseClient();
            const { error } = await supabase.auth.signInWithPassword({
                email,
                password,
            });

            if (error) throw error;

            router.push("/assistant");
        } catch (error: unknown) {
            setError(
                error instanceof Error
                    ? error.message
                    : "An error occurred during login",
            );
        } finally {
            setLoading(false);
        }
    };

    const submitLabel = isLocalAuth ? "Continue locally" : "Log in";

    return (
        <div className="min-h-dvh bg-gray-50/80 flex items-start justify-center px-6 pt-32 md:pt-40 pb-10 relative">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="lg" asLink />
            </div>
            <div className="w-full max-w-md">
                {/* Login Form */}
                <div className={`${authGlassCardClassName} mb-4`}>
                    <div className="flex justify-between items-center mb-6">
                        <h2 className="text-left text-2xl font-medium font-serif text-gray-950">
                            Log In
                        </h2>
                        <div className={authToggleClassName}>
                            <span className={authToggleActiveClassName}>
                                Log in
                            </span>
                            <Link
                                href="/signup"
                                className={authToggleInactiveClassName}
                            >
                                Sign up
                            </Link>
                        </div>
                    </div>
                    {isEntraAuth ? (
                        <div className="space-y-4">
                            {error && (
                                <div className="text-red-600 text-sm bg-red-50 p-3 rounded">
                                    {error}
                                </div>
                            )}
                            <Button
                                type="button"
                                onClick={handleMicrosoftLogin}
                                className="w-full mt-5 bg-black hover:bg-gray-900 text-white"
                            >
                                Sign in with Microsoft
                            </Button>
                        </div>
                    ) : (
                        <form onSubmit={handleLogin} className="space-y-4">
                            <div>
                                <label
                                    htmlFor="email"
                                    className="block text-sm font-medium text-gray-700 mb-2"
                                >
                                    Email
                                </label>
                                <Input
                                    id="email"
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    placeholder="Enter your email"
                                    required
                                    className={`w-full ${authInputClassName}`}
                                />
                            </div>

                            <div>
                                <label
                                    htmlFor="password"
                                    className="block text-sm font-medium text-gray-700 mb-2"
                                >
                                    Password
                                </label>
                                <Input
                                    id="password"
                                    type="password"
                                    value={password}
                                    onChange={(e) =>
                                        setPassword(e.target.value)
                                    }
                                    placeholder="Enter your password"
                                    required={!isLocalAuth}
                                    disabled={isLocalAuth}
                                    className={`w-full ${authInputClassName}`}
                                />
                            </div>

                            {error && (
                                <div className="text-red-600 text-sm bg-red-50 p-3 rounded">
                                    {error}
                                </div>
                            )}

                            <Button
                                type="submit"
                                disabled={loading}
                                className="w-full mt-5 bg-black hover:bg-gray-900 text-white"
                            >
                                {loading ? "Logging in..." : submitLabel}
                            </Button>
                        </form>
                    )}
                </div>
                {/* Set DEMO_MODE=true on the public demo backend. Customer
                    installs leave it unset and do not see this. */}
                {config.demoMode && (
                    <p className="text-center text-xs text-gray-500 leading-relaxed px-2">
                        Mike hosted on MikeOSS.com is currently a demo service.
                        Please do not upload, submit, or store sensitive,
                        confidential, privileged, client, or personally
                        identifiable documents.
                    </p>
                )}
            </div>
        </div>
    );
}
