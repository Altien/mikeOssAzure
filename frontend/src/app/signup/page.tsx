"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/app/lib/supabase";
import { Input } from "@/app/components/ui/input";
import { PillButton } from "@/app/components/ui/pill-button";
import Link from "next/link";
import { SiteLogo } from "@/app/components/site-logo";
import { useAuth } from "@/app/contexts/AuthContext";
import { updateUserProfile } from "@/app/lib/mikeApi";
import { browserAuthCallbackUrl } from "@/app/lib/authRedirects";
import { cn } from "@/app/lib/utils";
import {
    authGlassCardClassName,
    authInputClassName,
} from "@/app/components/auth/authStyles";
import { knownErrorCodeMessage } from "@/app/lib/userFacingError";

const SIGNUP_ERROR_MESSAGES = {
    user_already_exists: "An account with this email already exists.",
    email_exists: "An account with this email already exists.",
    over_email_send_rate_limit:
        "Too many signup emails were requested. Please wait and try again.",
    weak_password: "Choose a stronger password and try again.",
} as const;
import {
    MIN_PASSWORD_LENGTH,
    minimumPasswordMessage,
} from "@/app/components/auth/passwordPolicy";

function SignupContent() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { isAuthenticated, authLoading } = useAuth();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [name, setName] = useState("");
    const [organisation, setOrganisation] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);
    const isAccountCreatedPreview =
        process.env.NODE_ENV !== "production" &&
        searchParams.get("preview") === "account-created";

    useEffect(() => {
        if (isAccountCreatedPreview) return;
        if (!authLoading && isAuthenticated && !success) {
            router.replace("/assistant");
        }
    }, [
        authLoading,
        isAccountCreatedPreview,
        isAuthenticated,
        router,
        success,
    ]);

    const handleSignup = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        if (!name.trim()) {
            setError("Name is required");
            setLoading(false);
            return;
        }

        // Validate passwords match
        if (password !== confirmPassword) {
            setError("Passwords do not match");
            setLoading(false);
            return;
        }

        // Validate password length
        if (password.length < MIN_PASSWORD_LENGTH) {
            setError(minimumPasswordMessage);
            setLoading(false);
            return;
        }

        try {
            const trimmedEmail = email.trim();
            const trimmedName = name.trim();
            const trimmedOrg = organisation.trim();
            const emailRedirectTo = browserAuthCallbackUrl(
                "/assistant?confirmed=1",
            );
            const { data, error } = await supabase.auth.signUp({
                email: trimmedEmail,
                password,
                options: {
                    ...(emailRedirectTo ? { emailRedirectTo } : {}),
                    data: {
                        display_name: trimmedName || null,
                        organisation: trimmedOrg || null,
                    },
                },
            });

            if (error) throw error;

            if (data.session) {
                if (trimmedName || trimmedOrg) {
                    try {
                        await updateUserProfile({
                            ...(trimmedName && { displayName: trimmedName }),
                            ...(trimmedOrg && { organisation: trimmedOrg }),
                        });
                    } catch (profileError) {
                        console.error(
                            "[signup] failed to persist profile fields",
                            profileError,
                        );
                    }
                }
                setSuccess(true);
                setTimeout(() => {
                    router.push("/assistant");
                }, 2000);
            } else {
                router.push("/signup/check-email");
            }
        } catch (error: unknown) {
            setError(
                knownErrorCodeMessage(
                    error,
                    SIGNUP_ERROR_MESSAGES,
                    "Unable to create your account right now. Please try again.",
                ),
            );
        } finally {
            setLoading(false);
        }
    };

    // Success View
    if (success || isAccountCreatedPreview) {
        return (
            <div className="relative flex min-h-dvh items-center justify-center bg-gray-50/80 px-6 py-10">
                <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                    <SiteLogo size="lg" asLink />
                </div>
                <div className="w-full max-w-md">
                    <div className={authGlassCardClassName}>
                        <h1 className="font-serif text-2xl font-medium text-gray-950">
                            Account created!
                        </h1>
                        <p className="mt-3 text-sm leading-relaxed text-gray-600">
                            Redirecting you to the home page...
                        </p>
                        <PillButton
                            asChild
                            tone="black"
                            size="normal"
                            className="mt-6"
                        >
                            <Link href="/assistant">Continue</Link>
                        </PillButton>
                    </div>
                </div>
            </div>
        );
    }

    // Default Signup Form View
    return (
        <div className="min-h-dvh bg-gray-50/80 flex items-start justify-center px-6 pt-32 md:pt-40 pb-10 relative">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="lg" asLink />
            </div>
            <div className="w-full max-w-md">
                <div className={cn(authGlassCardClassName, "mb-4 pb-5")}>
                    <h2 className="mb-6 text-left text-2xl font-medium font-serif text-gray-950">
                        Sign Up
                    </h2>

                    <form onSubmit={handleSignup} className="space-y-4">
                        <div>
                            <label
                                htmlFor="name"
                                className="block text-sm font-medium text-gray-700 mb-2"
                            >
                                Name
                            </label>
                            <Input
                                id="name"
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                maxLength={200}
                                required
                                className={`w-full ${authInputClassName}`}
                            />
                        </div>

                        <div>
                            <label
                                htmlFor="organisation"
                                className="block text-sm font-medium text-gray-700 mb-2"
                            >
                                Organisation{" "}
                                <span className="text-gray-400 font-normal">
                                    (optional)
                                </span>
                            </label>
                            <Input
                                id="organisation"
                                type="text"
                                value={organisation}
                                onChange={(e) =>
                                    setOrganisation(e.target.value)
                                }
                                maxLength={200}
                                className={`w-full ${authInputClassName}`}
                            />
                        </div>

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
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder={`Create a password (min. ${MIN_PASSWORD_LENGTH} characters)`}
                                required
                                className={`w-full ${authInputClassName}`}
                            />
                        </div>

                        <div>
                            <label
                                htmlFor="confirmPassword"
                                className="block text-sm font-medium text-gray-700 mb-2"
                            >
                                Confirm Password
                            </label>
                            <Input
                                id="confirmPassword"
                                type="password"
                                value={confirmPassword}
                                onChange={(e) =>
                                    setConfirmPassword(e.target.value)
                                }
                                required
                                className={`w-full ${authInputClassName}`}
                            />
                        </div>

                        {error && (
                            <div className="text-red-600 text-sm bg-red-50 p-3 rounded">
                                {error}
                            </div>
                        )}

                        <div className="space-y-3 pt-2">
                            <div className="text-center text-xs text-gray-500">
                                By signing up, you agree to our{" "}
                                <Link
                                    href="https://mikeoss.com/terms"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-600 hover:underline"
                                >
                                    Terms of Use
                                </Link>{" "}
                                and{" "}
                                <Link
                                    href="https://mikeoss.com/privacy"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-600 hover:underline"
                                >
                                    Privacy Policy
                                </Link>
                            </div>
                            <PillButton
                                type="submit"
                                tone="black"
                                size="normal"
                                disabled={loading}
                                className="w-full"
                            >
                                {loading ? "Creating account..." : "Sign up"}
                            </PillButton>
                        </div>
                        <div className="text-center text-sm text-gray-500">
                            Have an account?{" "}
                            <Link
                                href="/login"
                                className="font-medium transition-colors hover:text-gray-950"
                            >
                                Log in
                            </Link>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    );
}

export default function SignupPage() {
    return (
        <Suspense fallback={null}>
            <SignupContent />
        </Suspense>
    );
}
