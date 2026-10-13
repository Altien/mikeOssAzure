"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import { useOrganizationInvitationCount } from "@/app/hooks/useOrganizationInvitationCount";
import {
    SettingsShell,
    type SettingsShellTab,
} from "@/app/components/settings/SettingsShell";

const TABS: SettingsShellTab[] = [
    { id: "account", label: "Account", href: "/settings" },
    {
        id: "personalisation",
        label: "Personalisation",
        href: "/settings/personalisation",
    },
    { id: "memory", label: "Memory", href: "/settings/memory" },
    { id: "appearance", label: "Appearance", href: "/settings/appearance" },
    { id: "features", label: "Features", href: "/settings/features" },
    {
        id: "privacy-data",
        label: "Privacy & Data",
        href: "/settings/privacy-data",
    },
    // Upstream divergence (sync-log: 3a10943): upstream adds a Security tab
    // (/settings/security) for Supabase Auth TOTP MFA management. Dev did not
    // adopt app-level Supabase MFA (Entra handles MFA at the IdP), so the
    // tab and page are omitted.
    { id: "models", label: "Model Preferences", href: "/settings/models" },
    {
        id: "byok",
        label: "Bring Your Own Keys",
        href: "/settings/byok",
    },
    { id: "connectors", label: "Connectors", href: "/settings/connectors" },
    // The organizations the person belongs to, and their invitations. Each
    // organization's own settings are a separate area, opened from here or
    // from the account menu.
    {
        id: "organizations",
        label: "Organizations",
        href: "/settings/organizations",
    },
];

export default function SettingsLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const router = useRouter();
    const { user, isAuthenticated, authLoading } = useAuth();
    const invitationCount = useOrganizationInvitationCount(
        isAuthenticated && !authLoading ? user?.id : undefined,
    );

    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.push("/");
        }
    }, [isAuthenticated, authLoading, router]);

    if (authLoading) {
        return (
            <div className="h-dvh flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
            </div>
        );
    }

    if (!isAuthenticated) {
        return null;
    }

    return (
        <SettingsShell
            title="Settings"
            navLabel="Settings"
            tabs={TABS.map((tab) =>
                tab.id === "organizations" && invitationCount > 0
                    ? {
                          ...tab,
                          badge: (
                              <span className="ml-2 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 px-1.5 text-xs font-semibold tabular-nums text-white">
                                  {invitationCount}{" "}
                                  <span className="sr-only">
                                      {invitationCount === 1
                                          ? "pending invitation"
                                          : "pending invitations"}
                                  </span>
                              </span>
                          ),
                      }
                    : tab,
            )}
            rootHref="/settings"
        >
            {children}
        </SettingsShell>
    );
}
