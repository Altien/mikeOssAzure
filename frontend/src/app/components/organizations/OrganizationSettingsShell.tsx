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
import { usePathname, useRouter } from "next/navigation";
import { OrganizationSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { TableEmptyState } from "@/app/components/shared/TablePrimitive";
import {
  SettingsShell,
  type SettingsShellTab,
} from "@/app/components/settings/SettingsShell";
import { EmptyState } from "@/app/components/ui/empty-state";
import {
  PERSONAL_WORKSPACE,
  useWorkspace,
} from "@/app/contexts/WorkspaceContext";
import { getOrg, type Org } from "@/app/lib/mikeApi";
import { isOrgAdmin, isOrgOwner } from "@/app/lib/permissions";
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
// An organization's settings are part of its workspace: they open only while
// that organization is the caller's active workspace, never from another
// organization's or from personal work. Somebody who follows a link from
// elsewhere is told so and offered the switch; nothing about the
// organization is read until they make it. Somebody who switches workspace
// while the settings are open is taken to the settings of the workspace they
// switched to, at the same section where they may open it.
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
  section: OrganizationSettingsSection = "general",
): string {
  const root = `/organizations/${orgId}/settings`;
  return section === "general" ? root : `${root}/${section}`;
}

type OrganizationSettingsSection =
  | "general"
  | "members"
  | "providers"
  | "privacy-data";

/** The section of `orgId`'s settings a path is in. */
function sectionOf(
  pathname: string | null,
  orgId: string,
): OrganizationSettingsSection {
  const root = organizationSettingsHref(orgId);
  const segment = pathname?.startsWith(`${root}/`)
    ? pathname.slice(root.length + 1).split("/")[0]
    : "";
  return segment === "members" ||
    segment === "providers" ||
    segment === "privacy-data"
    ? segment
    : "general";
}

/**
 * Where the settings go when the caller switches workspace with them open:
 * the same section of the new organization's settings if their role there
 * is offered it, otherwise General; and their own settings for Personal.
 */
function settingsHrefAfterSwitch(
  workspaceId: string,
  organizations: Org[] | null,
  section: OrganizationSettingsSection,
): string {
  if (workspaceId === PERSONAL_WORKSPACE) return "/settings";
  const role = organizations?.find((org) => org.id === workspaceId)?.role;
  const offered =
    section === "general" ||
    section === "members" ||
    (section === "providers" && !!role && isOrgAdmin(role)) ||
    (section === "privacy-data" && !!role && isOrgOwner(role));
  return organizationSettingsHref(workspaceId, offered ? section : "general");
}

export function OrganizationSettingsProvider({
  orgId,
  children,
}: {
  orgId: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { workspaceId, organizations, setWorkspace } = useWorkspace();
  const [org, setOrg] = useState<Org | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // `null` is "no workspace to compare with" (outside a WorkspaceProvider),
  // where nothing is narrowed.
  const inWorkspace = workspaceId === null || workspaceId === orgId;
  // Whether these settings have been open in their own workspace. Leaving it
  // from here is a switch made on this page, which the settings follow;
  // arriving from elsewhere is not, and is offered the switch instead.
  const [opened, setOpened] = useState({ orgId, was: workspaceId === orgId });
  if (opened.orgId !== orgId)
    setOpened({ orgId, was: workspaceId === orgId });
  else if (!opened.was && workspaceId === orgId)
    setOpened({ orgId, was: true });
  // Losing the organization (leaving it, its deletion, being removed) also
  // ends up in Personal, but is not a switch: those flows say where to go.
  const stillTheirs = !!organizations?.some((known) => known.id === orgId);
  const switchedTo =
    opened.orgId === orgId && opened.was && !inWorkspace && stillTheirs
      ? workspaceId
      : null;
  const section = sectionOf(pathname, orgId);

  useEffect(() => {
    if (!switchedTo) return;
    router.replace(settingsHrefAfterSwitch(switchedTo, organizations, section));
  }, [organizations, router, section, switchedTo]);

  const reload = useCallback(async () => {
    // Another workspace's settings are not read at all.
    if (!inWorkspace) return;
    try {
      setOrg(await getOrg(orgId));
      setLoadError(null);
    } catch (error) {
      setLoadError(
        userFacingApiError(error, "Could not load this organization."),
      );
    }
  }, [inWorkspace, orgId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- start the organization request once its id is known
    void reload();
  }, [reload]);

  const value = useMemo(
    () => ({ orgId, org, setOrg, reload }),
    [orgId, org, reload],
  );

  // On the way to the other workspace's settings: nothing of this one's.
  if (switchedTo) return null;

  if (!inWorkspace) {
    // Which organization this is can only be said once the caller's own
    // organizations are known, and only if it is one of them.
    if (organizations === null) return null;
    const theirs = organizations.find((candidate) => candidate.id === orgId);
    return (
      <TableEmptyState>
        {theirs ? (
          <EmptyState
            icon={<OrganizationSkeuoIcon />}
            title="Organization settings"
            description={`${theirs.name}'s settings can only be opened from its own workspace.`}
            action={
              <PillButtonUI
                tone="black"
                size="sm"
                onClick={() => setWorkspace(orgId)}
              >
                Switch to {theirs.name}
              </PillButtonUI>
            }
          />
        ) : (
          // Not one of theirs: say nothing about it, as a 404 would.
          <EmptyState
            icon={<OrganizationSkeuoIcon />}
            title="Organization settings"
            description="These settings are not available."
            action={
              <PillButtonUI
                tone="white"
                size="sm"
                onClick={() => router.push("/settings/organizations")}
              >
                Your organizations
              </PillButtonUI>
            }
          />
        )}
      </TableEmptyState>
    );
  }

  // Somebody who is not in the organization is told nothing about it, and a
  // failed read has no pages to show: either way there is no area to frame,
  // only the message and a retry.
  if (loadError && !org)
    return (
      <TableEmptyState>
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
      </TableEmptyState>
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
  const isOwner = org !== null && isOrgOwner(org.role);
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
      // Its actions reach every member's work, so it is its owners' alone.
      ...(isOwner
        ? [
            {
              id: "privacy-data",
              // Named as the same page is in a person's own settings.
              label: "Privacy & Data",
              href: organizationSettingsHref(orgId, "privacy-data"),
            },
          ]
        : []),
    ],
    [canManage, isOwner, orgId],
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
