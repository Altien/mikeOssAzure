"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { FullScreenLoader } from "@/app/components/shared/FullScreenLoader";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";

export function OnboardingGate({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const router = useRouter();
    const { user } = useAuth();
    const { profile, loading } = useUserProfile();
    const isOnboardingRoute = pathname.startsWith("/onboarding");
    const isAuthTransitionRoute =
        pathname === "/login" ||
        pathname === "/signup" ||
        pathname === "/signup/check-email" ||
        pathname === "/auth/callback";
    const needsOnboarding = profile?.onboardingComplete === false;
    const needsProfileDetails = !profile?.displayName?.trim();

    useEffect(() => {
        if (!user || loading || !profile) return;

        if (needsOnboarding && !isOnboardingRoute && !isAuthTransitionRoute) {
            router.replace("/onboarding/profile");
            return;
        }
        if (
            needsOnboarding &&
            pathname === "/onboarding/practice" &&
            needsProfileDetails
        ) {
            router.replace("/onboarding/profile");
            return;
        }
        if (!needsOnboarding && isOnboardingRoute) {
            router.replace("/assistant");
        }
    }, [
        isOnboardingRoute,
        isAuthTransitionRoute,
        loading,
        needsOnboarding,
        needsProfileDetails,
        pathname,
        profile,
        router,
        user,
    ]);

    if (!user) return <>{children}</>;
    if (loading || !profile) return <FullScreenLoader />;
    if (needsOnboarding && !isOnboardingRoute && !isAuthTransitionRoute) {
        return <FullScreenLoader />;
    }
    if (
        needsOnboarding &&
        pathname === "/onboarding/practice" &&
        needsProfileDetails
    ) {
        return <FullScreenLoader />;
    }
    if (!needsOnboarding && isOnboardingRoute) return <FullScreenLoader />;

    return <>{children}</>;
}
