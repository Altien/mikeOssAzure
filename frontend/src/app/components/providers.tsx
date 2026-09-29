"use client";

import { Suspense } from "react";
import { ConfigProvider } from "@/app/contexts/ConfigContext";
import { AuthProvider } from "@/app/contexts/AuthContext";
import { UserProfileProvider } from "@/app/contexts/UserProfileContext";
import { FullScreenLoader } from "@/app/components/shared/FullScreenLoader";

// Upstream divergence (OSS-6, auth): dev wraps the tree in ConfigProvider
// (runtime GET /config decides entra | local | supabase before AuthProvider
// mounts) and omits upstream's MfaLoginGate — there is no app-level MFA;
// Entra enforces MFA at the IdP.
export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <ConfigProvider>
            <AuthProvider>
                <UserProfileProvider>
                    <Suspense fallback={<FullScreenLoader />}>
                        {children}
                    </Suspense>
                </UserProfileProvider>
            </AuthProvider>
        </ConfigProvider>
    );
}
