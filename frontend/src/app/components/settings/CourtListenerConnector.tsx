"use client";

import { useState } from "react";
import Image from "next/image";
import { Modal } from "@/app/components/modals/Modal";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { useRequestOwner } from "@/app/hooks/useRequestOwner";
import { ApiKeyField } from "./ApiKeyField";

export const COURTLISTENER_NAME = "CourtListener";

export function CourtListenerIcon() {
  return (
    <Image
      src="/icons/integrations/courtlistener.svg"
      alt=""
      aria-hidden="true"
      width={20}
      height={20}
      unoptimized
      className="h-5 w-5 object-contain"
    />
  );
}

/**
 * CourtListener as a connector. It is installed once it has a token saved in
 * Mike (the user's own or their organization's) or the deployment answers
 * lookups from its bulk index. The on/off switch is the US case law research
 * setting; the token itself is managed in CourtListenerTokenModal.
 */
export function useCourtListenerConnector() {
  const owner = useRequestOwner();
  const { profile, updateLegalResearchUs } = useUserProfile();
  const [busy, setBusy] = useState(false);
  const [optimisticEnabled, setOptimisticEnabled] = useState<boolean | null>(
    null,
  );

  const key = profile?.apiKeys.courtlistener;
  const installed =
    !!profile && (!!key?.configured || profile.courtlistenerBulkData);
  const enabled = optimisticEnabled ?? profile?.legalResearchUs ?? true;

  const setEnabled = async (next: boolean) => {
    const isCurrent = owner.capture();
    if (!isCurrent()) return;
    if (busy) return;
    setOptimisticEnabled(next);
    setBusy(true);
    // A failure is reported by the profile context's notice (with Retry);
    // dropping the optimistic value puts the switch back.
    await updateLegalResearchUs(next);
    if (!isCurrent()) return;
    setBusy(false);
    setOptimisticEnabled(null);
  };

  return {
    loading: !profile,
    installed,
    enabled,
    busy,
    setEnabled,
  };
}

/**
 * Add (no token yet) or Manage (token saved) dialog: the token field, Save,
 * and Delete for a token the user saved themselves. When the deployment
 * answers lookups from its bulk index, the dialog says so.
 */
export function CourtListenerTokenModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { profile, updateApiKey, updateLegalResearchUs } = useUserProfile();
  if (!open) return null;
  const hasOwnToken = profile?.apiKeys.courtlistener.source === "user";

  return (
    <ApiKeyField
      variant="modal"
      label="CourtListener API token"
      keyLabel="API token"
      hasSavedKey={false}
      isServerConfigured
      // Dev managed-credential policy: token writes/removal stay refused.
      onSave={async () => false}
      onRemove={async () => false}
      render={(fields, saveAction, removeAction) => (
        <Modal
          open
          onClose={onClose}
          breadcrumbs={["Connectors", COURTLISTENER_NAME]}
          size="sm"
          className="h-auto max-h-[calc(100vh-2rem)]"
          primaryAction={{ label: "Close", onClick: onClose }}
        >
          <div
            data-modal-scroll="vertical"
            className="min-h-0 min-w-0 space-y-4 overflow-y-auto pb-4"
          >
            {profile?.courtlistenerBulkData && (
              <p className="text-sm text-gray-500">
                Bulk data installed and in use
              </p>
            )}
            <p className="text-sm text-gray-500">CourtListener credentials are managed by your organization through Key Vault. Contact your administrator to change them.</p>
            {fields}
          </div>
        </Modal>
      )}
    />
  );
}
