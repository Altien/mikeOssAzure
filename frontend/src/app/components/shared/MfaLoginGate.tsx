"use client";

import { Suspense, useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { FullScreenLoader } from "@/app/components/shared/FullScreenLoader";
import { needsMfaVerification } from "../popups/MfaVerificationPopup";

type GateState = "idle" | "checking" | "required" | "verified";
const MFA_VERIFIED_AT_KEY = "mike:mfa-verified-at";
const MFA_VERIFIED_GRACE_MS = 60_000;

export function MfaLoginGate({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const { user } = useAuth();
    const { profile, loading } = useUserProfile();
    const [gateState, setGateState] = useState<GateState>("idle");
    const isVerifyPage = pathname === "/verify-mfa";

    useEffect(() => {
        if (!user) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- sync fast paths of the async MFA check effect
            setGateState("idle");
            return;
        }
        if (loading) {
            return;
        }
        if (!profile?.mfaOnLogin) {
            setGateState("idle");
            return;
        }

        if (hasRecentMfaVerification()) {
            setGateState("verified");
            return;
        }

        let cancelled = false;

        async function checkLoginMfa() {
            try {
                const required = await needsMfaVerification();
                if (cancelled) return;
                setGateState(required ? "required" : "verified");
            } catch {
                if (!cancelled) setGateState("required");
            }
        }

        void checkLoginMfa();

        return () => {
            cancelled = true;
        };
    }, [loading, profile?.mfaOnLogin, user]);

    // Reset the gate synchronously when the auth/profile inputs change
    // (adjust-during-render); the async check above refines it.
    const checkKey = `${user?.id ?? ""}:${loading}:${profile?.mfaOnLogin ?? ""}`;
    const [prevCheckKey, setPrevCheckKey] = useState(checkKey);
    if (prevCheckKey !== checkKey) {
        setPrevCheckKey(checkKey);
        if (!user || loading || !profile?.mfaOnLogin) {
            setGateState("idle");
        } else if (hasRecentMfaVerification()) {
            setGateState("verified");
        } else {
            setGateState((previous) =>
                previous === "verified" ? "verified" : "checking",
            );
        }
    }

    // A just-completed verification (marked in sessionStorage by the verify
    // page) clears the gate without waiting for the async check.
    if (
        user &&
        !loading &&
        profile?.mfaOnLogin &&
        gateState === "required" &&
        hasRecentMfaVerification()
    ) {
        setGateState("verified");
    }

    const redirector = (
        <Suspense fallback={null}>
            <MfaGateRedirector
                hasUser={!!user}
                profileLoading={loading}
                mfaOnLogin={profile?.mfaOnLogin ?? false}
                gateState={gateState}
                isVerifyPage={isVerifyPage}
                pathname={pathname}
                onVerified={() => setGateState("verified")}
            />
        </Suspense>
    );

    if (user && loading) {
        return gateState === "verified" ? (
            <>
                {redirector}
                {children}
            </>
        ) : (
            <>
                {redirector}
                <FullScreenLoader />
            </>
        );
    }

    if (user && profile?.mfaOnLogin) {
        if (gateState === "required" && isVerifyPage) {
            return (
                <>
                    {redirector}
                    {children}
                </>
            );
        }
        if (gateState === "verified" && isVerifyPage) {
            return (
                <>
                    {redirector}
                    <FullScreenLoader />
                </>
            );
        }
        if (gateState === "verified") {
            return (
                <>
                    {redirector}
                    {children}
                </>
            );
        }
        return (
            <>
                {redirector}
                <FullScreenLoader />
            </>
        );
    }

    return (
        <>
            {redirector}
            {children}
        </>
    );
}

function MfaGateRedirector({
    hasUser,
    profileLoading,
    mfaOnLogin,
    gateState,
    isVerifyPage,
    pathname,
    onVerified,
}: {
    hasUser: boolean;
    profileLoading: boolean;
    mfaOnLogin: boolean;
    gateState: GateState;
    isVerifyPage: boolean;
    pathname: string;
    onVerified: () => void;
}) {
    const router = useRouter();
    const searchParams = useSearchParams();

    useEffect(() => {
        if (!hasUser || profileLoading || !mfaOnLogin) return;

        if (gateState === "required" && !isVerifyPage) {
            if (hasRecentMfaVerification()) {
                onVerified();
                return;
            }
            const search = searchParams.toString();
            const next = `${pathname}${search ? `?${search}` : ""}`;
            router.replace(`/verify-mfa?next=${encodeURIComponent(next)}`);
        } else if (gateState === "verified" && isVerifyPage) {
            const next = safeNextPath(searchParams.get("next"));
            router.replace(next);
        }
    }, [
        gateState,
        hasUser,
        isVerifyPage,
        mfaOnLogin,
        onVerified,
        pathname,
        profileLoading,
        router,
        searchParams,
    ]);

    return null;
}

function safeNextPath(value: string | null) {
    if (!value || !value.startsWith("/") || value.startsWith("//")) {
        return "/assistant";
    }
    if (value.startsWith("/verify-mfa")) return "/assistant";
    return value;
}

export function markMfaVerifiedForGate() {
    window.sessionStorage.setItem(MFA_VERIFIED_AT_KEY, String(Date.now()));
}

function hasRecentMfaVerification() {
    const raw = window.sessionStorage.getItem(MFA_VERIFIED_AT_KEY);
    const verifiedAt = raw ? Number.parseInt(raw, 10) : 0;
    return (
        Number.isFinite(verifiedAt) &&
        Date.now() - verifiedAt < MFA_VERIFIED_GRACE_MS
    );
}
