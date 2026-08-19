"use client";
import type { ReactNode } from "react";
import Link from "next/link";
import { useConfig, useConfigLoading } from "@/app/contexts/ConfigContext";
import { authGlassCardClassName } from "./authStyles";

// Mount provider-specific effects only after runtime configuration resolves.
export function SupabaseAuthGate({ children }: { children: ReactNode }) {
    const { authProvider } = useConfig();
    const loading = useConfigLoading();
    if (loading) return null;
    if (authProvider === "supabase") return children;
    return <div className="flex min-h-dvh items-center justify-center bg-gray-50 px-6">
        <div className={authGlassCardClassName}>
            <h1 className="font-serif text-2xl">Account managed by your sign-in provider</h1>
            <p className="mt-3 text-sm text-gray-600">Use your organisation’s sign-in process to manage your account.</p>
            <Link className="mt-6 inline-block underline" href="/login">Return to login</Link>
        </div>
    </div>;
}
