"use client";

import { ConfigProvider } from "@/contexts/ConfigContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { UserProfileProvider } from "@/contexts/UserProfileContext";

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
