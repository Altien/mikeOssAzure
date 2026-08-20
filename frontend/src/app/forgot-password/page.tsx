"use client";

import { useState } from "react";
import Link from "next/link";
import { Input } from "@/app/components/ui/input";
import { PillButton } from "@/app/components/ui/pill-button";
import { SiteLogo } from "@/app/components/site-logo";
import {
    authGlassCardClassName,
    authInputClassName,
} from "@/app/components/auth/authStyles";
import { browserAuthCallbackUrl } from "@/app/lib/authRedirects";
import { supabase } from "@/app/lib/supabase";

export default function ForgotPasswordPage() {
    const [email, setEmail] = useState("");
    const [loading, setLoading] = useState(false);
    const [submitted, setSubmitted] = useState(false);

    async function handleSubmit(event: React.FormEvent) {
        event.preventDefault();
        setLoading(true);
        try {
            const redirectTo = browserAuthCallbackUrl("/reset-password");
            await supabase.auth.resetPasswordForEmail(
                email.trim(),
                redirectTo ? { redirectTo } : undefined,
            );
        } catch {
            // Keep the response indistinguishable from a successful request.
        } finally {
            // Use the same response for existing and unknown addresses so this
            // screen cannot be used to enumerate Mike accounts.
            setSubmitted(true);
            setLoading(false);
        }
    }

    return (
        <div
            className={`relative flex min-h-dvh justify-center bg-gray-50/80 px-6 ${
                submitted
                    ? "items-center py-10"
                    : "items-start pb-10 pt-32 md:pt-40"
            }`}
        >
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="lg" asLink />
            </div>
            <div className="w-full max-w-md">
                <div className={authGlassCardClassName}>
                    {submitted ? (
                        <div>
                            <h1 className="text-2xl font-medium font-serif text-gray-950">
                                Check your email
                            </h1>
                            <p className="mt-3 text-sm leading-relaxed text-gray-600">
                                If an account exists for {email.trim()}, we sent
                                a password-reset link. The link expires and can
                                only be used once.
                            </p>
                            <PillButton
                                asChild
                                tone="black"
                                size="normal"
                                className="mt-6"
                            >
                                <Link href="/login">Return to login</Link>
                            </PillButton>
                        </div>
                    ) : (
                        <>
                            <h1 className="text-2xl font-medium font-serif text-gray-950">
                                Reset your password
                            </h1>
                            <p className="mt-2 text-sm leading-relaxed text-gray-500">
                                Enter your account email and we will send you a
                                secure reset link.
                            </p>
                            <form
                                onSubmit={handleSubmit}
                                className="mt-6 space-y-4"
                            >
                                <div>
                                    <label
                                        htmlFor="email"
                                        className="mb-2 block text-sm font-medium text-gray-700"
                                    >
                                        Email
                                    </label>
                                    <Input
                                        id="email"
                                        type="email"
                                        autoComplete="email"
                                        value={email}
                                        onChange={(event) =>
                                            setEmail(event.target.value)
                                        }
                                        required
                                        className={`w-full ${authInputClassName}`}
                                    />
                                </div>
                                <PillButton
                                    type="submit"
                                    tone="black"
                                    size="normal"
                                    disabled={loading || !email.trim()}
                                    className="w-full"
                                >
                                    {loading
                                        ? "Sending reset link..."
                                        : "Send reset link"}
                                </PillButton>
                            </form>
                            <div className="mt-5 text-center">
                                <Link
                                    href="/login"
                                    className="text-sm font-medium text-gray-500 transition-colors hover:text-gray-950"
                                >
                                    Return to login
                                </Link>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
