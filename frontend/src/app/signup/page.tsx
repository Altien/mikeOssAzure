"use client";

import Link from "next/link";
import { SiteLogo } from "@/components/site-logo";

export default function SignupPage() {
    return (
        <div className="min-h-dvh bg-white flex items-start justify-center px-6 pt-32 md:pt-40 pb-10 relative">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="md" className="md:text-4xl" asLink />
            </div>
            <div className="w-full max-w-md">
                <div className="bg-white border border-gray-200 rounded-2xl p-8 text-center">
                    <h2 className="text-2xl font-serif mb-4">Sign up unavailable</h2>
                    <p className="text-gray-600 leading-relaxed mb-6">
                        Account creation is managed by your organisation. Please sign in with your Microsoft account.
                    </p>
                    <Link
                        href="/login"
                        className="inline-flex items-center justify-center rounded-md bg-black px-4 py-2 text-sm text-white hover:bg-gray-900"
                    >
                        Go to login
                    </Link>
                </div>
            </div>
        </div>
    );
}
