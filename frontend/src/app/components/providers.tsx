"use client";

import { ConfigProvider } from "@/app/contexts/ConfigContext";
import { AuthProvider } from "@/app/contexts/AuthContext";
import { UserProfileProvider } from "@/app/contexts/UserProfileContext";

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <ConfigProvider>
            <AuthProvider>
                <UserProfileProvider>
                    {children}
                </UserProfileProvider>
            </AuthProvider>
        </ConfigProvider>
    );
}
