"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
    Brain,
    Building2,
    Cpu,
    HatGlasses,
    History,
    KeyRound,
    Loader2,
    Palette,
    Plug,
    ShieldCheck,
    ToggleRight,
    UserPen,
    UserRound,
} from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import { useConfig } from "@/app/contexts/ConfigContext";
import { useOrganizationInvitationCount } from "@/app/hooks/useOrganizationInvitationCount";
import { useMemberDataActions } from "@/app/hooks/useMemberDataActions";
import { getTenantAdminStatus } from "@/app/lib/mikeApi";
import { useWorkspaceSettingsScope } from "@/app/hooks/useWorkspaceSettingsScope";
import {
    SettingsShell,
    type SettingsShellGroup,
    type SettingsShellTab,
} from "@/app/components/settings/SettingsShell";
import { SettingsSearch } from "@/app/components/settings/SettingsSearch";
import { SETTINGS_SEARCH_ENTRIES } from "@/app/lib/settingsSearch";

// Settings come in two groups. Workspace settings belong to the workspace in
// view (Personal, or one of the person's organizations): each workspace keeps
// its own, and switching workspace switches them. In Personal they are the
// person's own; in an organization's workspace, Features, Model Preferences
// and Bring Your Own Keys are the organization's. Personal settings are the
// person's own and follow them into every workspace.
const GROUPS: SettingsShellGroup[] = [
    {
        id: "workspace",
        label: "Workspace",
        tabs: [
            {
                id: "memory",
                label: "Memory",
                href: "/settings/memory",
                icon: Brain,
            },
            {
                id: "connectors",
                label: "Connectors",
                href: "/settings/connectors",
                icon: Plug,
            },
            {
                id: "features",
                label: "Features",
                href: "/settings/features",
                icon: ToggleRight,
            },
            {
                id: "models",
                label: "Model Preferences",
                href: "/settings/models",
                icon: Cpu,
            },
            {
                id: "byok",
                label: "Bring Your Own Keys",
                href: "/settings/byok",
                icon: KeyRound,
            },
            {
                id: "privacy-data",
                label: "Privacy & Data",
                href: "/settings/privacy-data",
                icon: HatGlasses,
            },
        ],
    },
    {
        id: "personal",
        label: "Personal",
        tabs: [
            {
                id: "account",
                label: "Account",
                href: "/settings",
                icon: UserRound,
            },
            {
                id: "personalisation",
                label: "Personalisation",
                href: "/settings/personalisation",
                icon: UserPen,
            },
            {
                id: "appearance",
                label: "Appearance",
                href: "/settings/appearance",
                icon: Palette,
            },
            // Upstream divergence (sync-log: 3a10943): upstream adds a Security
            // tab (/settings/security) for Supabase Auth TOTP MFA management.
            // Dev did not adopt app-level Supabase MFA (Entra handles MFA at
            // the IdP), so the tab and page are omitted.
            {
                id: "my-activity",
                label: "My Activity",
                href: "/settings/my-activity",
                icon: History,
            },
            // The organizations the person belongs to, and their invitations.
            // Each organization's own settings are a separate area, opened
            // from here or from the account menu.
            {
                id: "organizations",
                label: "Organizations",
                href: "/settings/organizations",
                icon: Building2,
            },
        ],
    },
];

// In an organization's workspace these are the organization's, set by its
// owners and admins for everyone working there; a member has nothing to
// change, so they are not listed (useWorkspaceSettingsScope).
const GOVERNED_TAB_IDS = new Set(["features", "models", "byok"]);

// Multi-tenant divergence: pooled tenant administration, listed (in the
// Personal group) only for a confirmed TenantAdmin in pooled tenancy mode.
const TENANT_ADMIN_TAB: SettingsShellTab = {
    id: "organisation",
    label: "Organisation",
    href: "/settings/organisation",
    icon: ShieldCheck,
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
    const [organisationAdmin,setOrganisationAdmin] = useState<string | null>(null);

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

    // Dev (pooled tenancy): the tenant-admin tab joins the list, and so its
    // search entries, only for a confirmed tenant administrator.
    const showTenantAdmin =
        tenancyMode === "pooled" &&
        organisationAdmin !== null &&
        organisationAdmin === (user?.id ?? "");
    const scope = useWorkspaceSettingsScope().kind;
    const hideGoverned = scope !== "personal" && scope !== "organization";
    const visibleGroups = useMemo(
        () =>
            GROUPS.map((group) => ({
                ...group,
                tabs: [
                    ...group.tabs,
                    ...(showTenantAdmin && group.id === "personal"
                        ? [TENANT_ADMIN_TAB]
                        : []),
                ].filter(
                    (tab) =>
                        !(hidePrivacyData && tab.id === "privacy-data") &&
                        !(hideGoverned && GOVERNED_TAB_IDS.has(tab.id)),
                ),
            })),
        [showTenantAdmin, hideGoverned, hidePrivacyData],
    );
    // Search only what is listed: an entry on a hidden tab would open a page
    // the person is not offered.
    const searchEntries = useMemo(() => {
        const visibleTabIds = new Set(
            visibleGroups.flatMap((group) => group.tabs.map((tab) => tab.id)),
        );
        return SETTINGS_SEARCH_ENTRIES.filter((entry) =>
            visibleTabIds.has(entry.tabId),
        );
    }, [visibleGroups]);

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

    return (
        <SettingsShell
            title="Settings"
            navLabel="Settings"
            search={<SettingsSearch entries={searchEntries} />}
            groups={visibleGroups.map((group) => ({
                ...group,
                tabs: group.tabs.map((tab) =>
                    tab.id === "organizations" && invitationCount > 0
                        ? {
                              ...tab,
                              badge: (
                                  <InvitationCountBadge
                                      count={invitationCount}
                                  />
                              ),
                          }
                        : tab,
                ),
            }))}
            rootHref="/settings"
        >
            {children}
        </SettingsShell>
    );
}

function InvitationCountBadge({ count }: { count: number }) {
    return (
        <span className="ml-2 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 px-1.5 text-xs font-semibold tabular-nums text-white">
            {count}{" "}
            <span className="sr-only">
                {count === 1 ? "pending invitation" : "pending invitations"}
            </span>
        </span>
    );
}
