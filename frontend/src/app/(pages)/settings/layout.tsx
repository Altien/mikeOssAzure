"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import { useConfig } from "@/app/contexts/ConfigContext";
import { useOrganizationInvitationCount } from "@/app/hooks/useOrganizationInvitationCount";
import { useMemberDataActions } from "@/app/hooks/useMemberDataActions";
import { getTenantAdminStatus } from "@/app/lib/mikeApi";
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
    { id: "my-activity", label: "My Activity", href: "/settings/my-activity" },
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

// Multi-tenant divergence: pooled tenant administration, listed only for a
// confirmed TenantAdmin in pooled tenancy mode.
const TENANT_ADMIN_TAB: SettingsShellTab = {
    id: "organisation",
    label: "Organisation",
    href: "/settings/organisation",
};

export default function SettingsLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const router = useRouter();
    const pathname = usePathname();
    const { user, isAuthenticated, authLoading } = useAuth();
    const { tenancyMode } = useConfig();
    const invitationCount = useOrganizationInvitationCount(
        isAuthenticated && !authLoading ? user?.id : undefined,
    );
    // Privacy & Data has nothing to offer a member of an organization whose
    // owners allow neither exports nor bulk deletes, so it is not listed.
    const { canExport, canDelete } = useMemberDataActions();
    const hidePrivacyData = !canExport && !canDelete;
    const [organisationAdmin, setOrganisationAdmin] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setOrganisationAdmin(null);
        if (tenancyMode === "pooled" && isAuthenticated && !authLoading) {
            void getTenantAdminStatus().then((status) => {
                if (!cancelled && status.isTenantAdmin) setOrganisationAdmin(user?.id ?? "");
            }).catch(() => {
                // A failed permission check leaves the admin navigation hidden.
            });
        }
        return () => { cancelled = true; };
    }, [tenancyMode, isAuthenticated, authLoading, user?.id]);

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

    // My Activity is linked from Settings but uses the full table-page layout.
    if (pathname === "/settings/my-activity") {
        return children;
    }

    const showTenantAdmin =
        tenancyMode === "pooled" &&
        organisationAdmin !== null &&
        organisationAdmin === (user?.id ?? "");
    const baseTabs = showTenantAdmin ? [...TABS, TENANT_ADMIN_TAB] : TABS;

    return (
        <SettingsShell
            title="Settings"
            navLabel="Settings"
            tabs={baseTabs.filter(
                (tab) => !(hidePrivacyData && tab.id === "privacy-data"),
            ).map((tab) =>
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
