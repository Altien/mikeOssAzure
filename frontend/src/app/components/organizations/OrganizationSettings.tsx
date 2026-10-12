"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { EmptyState } from "@/app/components/ui/empty-state";
import { OrganizationSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import { getOrg, type Org } from "@/app/lib/mikeApi";
import { isOrgAdmin, isOrgOwner } from "@/app/lib/permissions";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { OrganizationSettingsModal } from "./OrganizationModals";
import { OrganizationProviderKeys } from "./OrganizationProviderKeys";

// An organization's settings: its name, the model providers its work runs
// on, and — for owners — deleting it.
//
// The page is its owners' and admins' alone. Every change here is refused by
// the server for anyone else; the page itself also declines to render for
// them, so a member following a link is told why instead of being shown
// controls that cannot work.

export function OrganizationSettings({ orgId }: { orgId: string }) {
  const router = useRouter();
  const { refreshOrganizations } = useWorkspace();
  const [org, setOrg] = useState<Org | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setOrg(await getOrg(orgId));
    } catch (error) {
      setLoadError(
        userFacingApiError(error, "Could not load this organization."),
      );
    }
  }, [orgId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- start the organization request once its id is known
    void load();
  }, [load]);

  const loading = org === null && loadError === null;
  const canManage = org !== null && isOrgAdmin(org.role);
  const backToOrganization = () => router.push(`/organizations/${orgId}`);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <PageHeader
        loading={loading}
        breadcrumbs={[
          {
            label: "Organizations",
            onClick: () => router.push("/organizations"),
            title: "Back to Organizations",
          },
          org
            ? {
                label: org.name,
                onClick: backToOrganization,
                title: `Back to ${org.name}`,
              }
            : { loading: true, skeletonClassName: "w-40" },
          { label: "Settings", cursor: "text" },
        ]}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-3 max-w-4xl space-y-8 pb-8 md:mx-6.5">
          {loadError ? (
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
                    // Back to the loading state while the retry is out.
                    setLoadError(null);
                    void load();
                  }}
                >
                  Try again
                </PillButtonUI>
              }
            />
          ) : org && !canManage ? (
            <EmptyState
              icon={<OrganizationSkeuoIcon />}
              title="Organization settings"
              description="Only this organization's owners and admins can open its settings."
              action={
                <PillButtonUI
                  tone="white"
                  size="sm"
                  onClick={backToOrganization}
                >
                  Back to {org.name}
                </PillButtonUI>
              }
            />
          ) : (
            <>
              <section
                aria-labelledby="org-settings-general"
                className="space-y-3"
              >
                <SettingsHeading id="org-settings-general">
                  General
                </SettingsHeading>
                {org ? (
                  <SettingsDescription>
                    {isOrgOwner(org.role)
                      ? "Rename the organization, or delete it."
                      : "Rename the organization."}
                  </SettingsDescription>
                ) : (
                  <span className="block h-5 w-56 max-w-full animate-pulse rounded bg-gray-200" />
                )}
                <GlassCardUI>
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4">
                    <div className="min-w-0 flex-[1_1_16rem] space-y-1">
                      <SettingsLabel>Organization name</SettingsLabel>
                      {org ? (
                        <p className="text-sm break-words text-gray-500">
                          {org.name}
                        </p>
                      ) : (
                        <span className="block h-5 w-40 max-w-full animate-pulse rounded bg-gray-200" />
                      )}
                    </div>
                    <div className="ml-auto flex shrink-0 items-center">
                      <PillButtonUI
                        tone="white"
                        size="sm"
                        disabled={!org}
                        aria-haspopup="dialog"
                        aria-label={
                          org && isOrgOwner(org.role)
                            ? "Rename or delete organization"
                            : "Rename organization"
                        }
                        onClick={() => setDetailsOpen(true)}
                      >
                        Edit
                      </PillButtonUI>
                    </div>
                  </div>
                </GlassCardUI>
              </section>

              {/* Mounted with the page so its cards load alongside the name,
                  not after it. It reads the caller's rights itself. */}
              <OrganizationProviderKeys
                orgId={orgId}
                orgName={org?.name ?? "Organization"}
              />
            </>
          )}
        </div>
      </div>

      {org && canManage ? (
        <OrganizationSettingsModal
          open={detailsOpen}
          org={org}
          canDelete={isOrgOwner(org.role)}
          onClose={() => setDetailsOpen(false)}
          onUpdated={(updated) => {
            setOrg((current) => ({
              ...updated,
              member_count: current?.member_count,
            }));
            setDetailsOpen(false);
            // The sidebar and the workspace switcher show the name too.
            void refreshOrganizations();
          }}
          onDeleted={() => {
            void refreshOrganizations();
            router.push("/organizations");
          }}
        />
      ) : null}
    </div>
  );
}
