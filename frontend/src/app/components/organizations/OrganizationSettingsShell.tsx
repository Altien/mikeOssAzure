"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { OrganizationSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import {
  SettingsShell,
  type SettingsShellTab,
} from "@/app/components/settings/SettingsShell";
import { EmptyState } from "@/app/components/ui/empty-state";
import { getOrg, type Org } from "@/app/lib/mikeApi";
import { isOrgAdmin } from "@/app/lib/permissions";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

// An organization's settings area: the same frame as a person's settings,
// with its sections down the side.
//
//   General          everyone in the organization
//   Members          everyone in the organization; a full table page of its
//                    own rather than a section inside the frame
//   Model Providers  its owners and admins
//
// OrganizationSettingsProvider loads the organization once and hands it to
// every page under settings, so they agree about the name and about what the
// caller may do. OrganizationSettingsFrame is the sectioned frame around the
// pages that sit inside it. The server still decides every change; a section
// a member cannot use is not offered.

interface OrganizationSettingsContextValue {
  orgId: string;
  /** `null` until the organization has loaded. */
  org: Org | null;
  /** Put a changed organization (a new name) in place without a re-read. */
  setOrg: (org: Org) => void;
  /** Re-read the organization, after the caller's role may have changed. */
  reload: () => Promise<void>;
}

const OrganizationSettingsContext =
  createContext<OrganizationSettingsContextValue | null>(null);

export function useOrganizationSettings(): OrganizationSettingsContextValue {
  const value = useContext(OrganizationSettingsContext);
  if (!value)
    throw new Error(
      "useOrganizationSettings must be used inside OrganizationSettingsShell",
    );
  return value;
}

export function organizationSettingsHref(
  orgId: string,
  section: "general" | "members" | "providers" = "general",
): string {
  const root = `/organizations/${orgId}/settings`;
  return section === "general" ? root : `${root}/${section}`;
}

export function OrganizationSettingsProvider({
  orgId,
  children,
}: {
  orgId: string;
  children: ReactNode;
}) {
  const [org, setOrg] = useState<Org | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setOrg(await getOrg(orgId));
      setLoadError(null);
    } catch (error) {
      setLoadError(
        userFacingApiError(error, "Could not load this organization."),
      );
    }
  }, [orgId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- start the organization request once its id is known
    void reload();
  }, [reload]);

  const value = useMemo(
    () => ({ orgId, org, setOrg, reload }),
    [orgId, org, reload],
  );

  // Somebody who is not in the organization is told nothing about it, and a
  // failed read has no pages to show: either way there is no area to frame,
  // only the message and a retry.
  if (loadError && !org)
    return (
      <div className="mx-auto w-full max-w-5xl px-6 pt-16 md:pt-24">
        <EmptyState
          icon={<OrganizationSkeuoIcon />}
          title="Organization settings"
          description={loadError}
          tone="error"
          action={
            <PillButtonUI
              tone="white"
              size="sm"
              onClick={() => {
                setLoadError(null);
                void reload();
              }}
            >
              Try again
            </PillButtonUI>
          }
        />
      </div>
    );

  return (
    <OrganizationSettingsContext.Provider value={value}>
      {children}
    </OrganizationSettingsContext.Provider>
  );
}

/** The sectioned frame around the settings pages that sit inside it. */
export function OrganizationSettingsFrame({
  children,
}: {
  children: ReactNode;
}) {
  const { orgId, org } = useOrganizationSettings();
  const canManage = org !== null && isOrgAdmin(org.role);
  const tabs = useMemo<SettingsShellTab[]>(
    () => [
      {
        id: "general",
        label: "General",
        href: organizationSettingsHref(orgId),
      },
      // A table page of its own; its header leads back here.
      {
        id: "members",
        label: "Members",
        href: organizationSettingsHref(orgId, "members"),
      },
      // Not offered to a member, nor before the caller's role is known.
      ...(canManage
        ? [
            {
              id: "providers",
              label: "Model Providers",
              href: organizationSettingsHref(orgId, "providers"),
            },
          ]
        : []),
    ],
    [canManage, orgId],
  );

  return (
    <SettingsShell
      title="Organization Settings"
      navLabel="Organization settings"
      tabs={tabs}
      rootHref={organizationSettingsHref(orgId)}
    >
      {children}
    </SettingsShell>
  );
}
