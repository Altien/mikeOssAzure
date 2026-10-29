"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { Modal } from "@/app/components/modals/Modal";
import {
  type CourtListenerConnectorStatus,
  deleteCourtListenerConnectorToken,
  getCourtListenerConnector,
  saveCourtListenerConnectorToken,
  setCourtListenerConnectorEnabled,
} from "@/app/lib/mikeApi";
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
 * CourtListener as a connector in one workspace ("personal" or an
 * organization id; undefined is read as Personal). It is listed under
 * Installed while it is switched on and has a token (the user's own for this
 * workspace, or the organization's) or the deployment's bulk index, or while
 * the user has saved a token of their own here; otherwise it is offered in
 * Discover. The on/off switch and the user's own token are kept per
 * workspace; the token is managed in CourtListenerTokenModal.
 *
 * Every action throws on failure, so the caller can route errors and MFA
 * challenges as it does for the other connectors.
 */
export function useCourtListenerConnector(workspace?: string) {
  const requestOwner = useRequestOwner();
  const [status, setStatus] = useState<CourtListenerConnectorStatus | null>(
    null,
  );
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [optimisticEnabled, setOptimisticEnabled] = useState<boolean | null>(
    null,
  );

  useEffect(() => {
    let mounted = true;
    const isCurrent = requestOwner.capture();
    setStatus(null);
    getCourtListenerConnector(workspace, isCurrent)
      .then((next) => {
        if (!mounted || !isCurrent()) return;
        setStatus(next);
        setLoadFailed(false);
      })
      .catch(() => {
        if (mounted && isCurrent()) setLoadFailed(true);
      });
    return () => {
      mounted = false;
    };
  }, [workspace, requestOwner.key]);

  const setEnabled = useCallback(
    async (next: boolean) => {
      const isCurrent = requestOwner.capture();
      if (!isCurrent()) return;
      setOptimisticEnabled(next);
      setBusy(true);
      try {
        const nextStatus = await setCourtListenerConnectorEnabled(next, workspace, isCurrent);
        if (isCurrent()) setStatus(nextStatus);
      } finally {
        // On failure, dropping the optimistic value puts the switch back.
        if (isCurrent()) { setBusy(false); setOptimisticEnabled(null); }
      }
    },
    [workspace, requestOwner.capture],
  );

  // Dev managed credentials: keep the incoming connector interface, refuse token writes.
  const saveToken = useCallback(async (_token: string) => { throw new Error("CourtListener credentials are managed by your organization."); }, []);
  const deleteToken = useCallback(async () => { throw new Error("CourtListener credentials are managed by your organization."); }, []);

  return {
    status,
    loading: !status && !loadFailed,
    loadFailed,
    installed: status?.installed === true,
    enabled: optimisticEnabled ?? status?.enabled ?? true,
    busy,
    setEnabled,
    saveToken,
    deleteToken,
  };
}

export type CourtListenerConnector = ReturnType<
  typeof useCourtListenerConnector
>;

/**
 * Add (no token yet) or Manage (token saved) dialog: the token field, Save,
 * and Delete for a token the user saved themselves in this workspace. When
 * the organization supplies a token, or the deployment's bulk index is in
 * use (it is installed and CourtListener is on), the dialog says so.
 */
export function CourtListenerTokenModal({
  open,
  onClose,
  connector,
  organizationName,
}: {
  open: boolean;
  onClose: () => void;
  connector: CourtListenerConnector;
  /** The active organization's name, or null in Personal. */
  organizationName: string | null;
}) {
  if (!open) return null;
  const status = connector.status;
  const hasOwnToken = status?.ownToken === true;
  const organizationToken = status?.tokenSource === "org";

  return (
    <ApiKeyField
      variant="modal"
      label="CourtListener API token"
      keyLabel={organizationToken ? "Your API token (optional)" : "API token"}
      hasSavedKey={false}
      isServerConfigured
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
            {organizationToken && (
              <p className="text-sm break-words text-gray-500">
                {organizationName ?? "Your organization"} provides a
                CourtListener token. Credentials are managed through Key Vault.
              </p>
            )}
            {status?.bulkData && connector.enabled && (
              <p className="text-sm text-gray-500">
                Bulk data installed and in use
              </p>
            )}
            {fields}
          </div>
        </Modal>
      )}
    />
  );
}
