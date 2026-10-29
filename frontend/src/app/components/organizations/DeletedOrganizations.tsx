"use client";
import { useRequestOwner } from "@/app/hooks/useRequestOwner";

import { useCallback, useEffect, useState } from "react";
import {
  listDeletedOrganizations,
  restoreOrganization,
  type DeletedOrganization,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

export function DeletedOrganizations(props: { onRestored: () => Promise<void> }) {
  const { key } = useRequestOwner();
  return <DeletedOrganizationsOwned key={key} {...props} />;
}

function DeletedOrganizationsOwned({
  onRestored,
}: {
  onRestored: () => Promise<void>;
}) {
  const { capture } = useRequestOwner();
  const { refreshOrganizations } = useWorkspace();
  const [orgs, setOrgs] = useState<DeletedOrganization[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    const isCurrent = capture();
    if (!isCurrent()) return;
    try {
      const result = await listDeletedOrganizations(isCurrent);
      if (!isCurrent()) return;
      setOrgs(result);
      setLoadError(false);
    } catch {
      if (isCurrent()) setLoadError(true);
    }
  }, [capture]);
  useEffect(() => {
    void load();
  }, [load]);

  async function restore(id: string) {
    const isCurrent = capture();
    if (!isCurrent() || busy) return;
    setBusy(id);
    try {
      if (!isCurrent()) return;
      await restoreOrganization(id, isCurrent);
      if (!isCurrent()) return;
      setOrgs((current) => current?.filter((org) => org.id !== id) ?? []);
    } catch (err) {
      if (!isCurrent()) return;
      setError(userFacingApiError(err, "Could not restore the organization."));
      return;
    } finally {
      if (isCurrent()) setBusy(null);
    }
    // A refresh failure must not report a successful restore as a failed one.
    if (isCurrent()) await Promise.allSettled([load(), onRestored(), refreshOrganizations()]);
  }

  if (orgs?.length === 0 && !loadError) return null;
  return (
    <section
      aria-labelledby="deleted-organizations-heading"
      className="space-y-3"
    >
      <SettingsHeading id="deleted-organizations-heading">
        Recently deleted
      </SettingsHeading>
      <SettingsDescription>
        Owners can restore an organization within 30 days of deletion.
      </SettingsDescription>
      {loadError ? (
        <PillButtonUI tone="white" size="sm" onClick={() => void load()}>
          Retry deleted organizations
        </PillButtonUI>
      ) : orgs === null ? (
        <div
          aria-label="Loading deleted organizations"
          aria-busy="true"
          className="h-16 animate-pulse rounded-lg bg-gray-200"
        />
      ) : (
        <GlassCardUI>
          {orgs.map((org) => (
            <SettingsRow key={org.id}>
              <div className="min-w-0 space-y-1 [overflow-wrap:anywhere]">
                <SettingsLabel>{org.name}</SettingsLabel>
                <SettingsDescription>
                  Recover before {new Date(org.purge_after).toLocaleString()}.
                </SettingsDescription>
              </div>
              <PillButtonUI
                tone="black"
                size="sm"
                disabled={busy !== null}
                loading={busy === org.id}
                aria-label={`Restore ${org.name}`}
                onClick={() => void restore(org.id)}
              >
                Restore
              </PillButtonUI>
            </SettingsRow>
          ))}
        </GlassCardUI>
      )}
      <WarningPopup
        open={error !== null}
        title="Restore failed"
        message={error}
        onClose={() => setError(null)}
      />
    </section>
  );
}
