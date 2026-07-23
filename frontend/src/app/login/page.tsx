"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabase";
import { useConfig } from "@/contexts/ConfigContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Link from "next/link";
import { SiteLogo } from "@/components/site-logo";
import { useAuth } from "@/contexts/AuthContext";
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
        const apiBase = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001") + "/api";
        const returnUrl = encodeURIComponent(window.location.origin + "/assistant");
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
            const { data, error } = await supabase.auth.signInWithPassword({
                email,
                password,
            });

            if (error) throw error;

            router.push("/assistant");
        } catch (error: any) {
            setError(error.message || "An error occurred during login");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-dvh bg-white flex items-start justify-center px-6 pt-32 md:pt-40 pb-10 relative">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="md" className="md:text-4xl" asLink />
            </div>
            <div className="w-full max-w-md">
                {/* Login Form */}
                <div className="bg-white border border-gray-200 rounded-2xl p-8 mb-4">
                    <div className="flex justify-between items-center mb-6">
                        <h2 className="text-left text-2xl font-serif">
                            Log In
                        </h2>
                        <div className="bg-gray-100 p-1 rounded-md flex text-xs font-medium">
                            <span className="text-gray-600 px-3 py-1 bg-white rounded-sm shadow-sm">
                                Log in
                            </span>
                            <Link
                                href="/signup"
                                className="px-3 py-1 text-gray-500 hover:text-gray-900"
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
                                className="w-full"
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
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="Enter your password"
                                required={!isLocalAuth}
                                disabled={isLocalAuth}
                                className="w-full"
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
                            {loading ? "Logging in..." : isLocalAuth ? "Continue locally" : "Log in"}
                        </Button>
                    </form>
                    )}
                </div>
                {/* Set DEMO_MODE=true on the public demo backend.
                    Self-hosted installs leave it unset and do not see this. */}
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
