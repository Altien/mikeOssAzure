"use client";

import { Suspense } from "react";
import { ConfigProvider } from "@/app/contexts/ConfigContext";
import { AuthProvider } from "@/app/contexts/AuthContext";
import { UserProfileProvider } from "@/app/contexts/UserProfileContext";
import { FullScreenLoader } from "@/app/components/shared/FullScreenLoader";
import { AoaiDeploymentsProvider } from "@/altien/models/aoaiDeployments";
import { OnboardingGate } from "@/app/components/auth/OnboardingGate";

// Upstream divergence (OSS-6, auth): dev wraps the tree in ConfigProvider
// (runtime GET /config decides entra | local | supabase before AuthProvider
// mounts) and omits upstream's MfaLoginGate — there is no app-level MFA;
// Entra enforces MFA at the IdP.
// Upstream divergence (OSS-6, §2.3 item 3): AoaiDeploymentsProvider shares
// the discovered Azure OpenAI deployments with every model picker.
export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <ConfigProvider>
            <AuthProvider>
                <UserProfileProvider>
                    <AoaiDeploymentsProvider>
                        <Suspense fallback={<FullScreenLoader />}>
                            <OnboardingGate>{children}</OnboardingGate>
                        </Suspense>
                    </AoaiDeploymentsProvider>
                </UserProfileProvider>
            </AuthProvider>
        </ConfigProvider>
    );
}
