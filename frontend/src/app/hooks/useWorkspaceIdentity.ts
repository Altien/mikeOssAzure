"use client";

import { useSyncExternalStore } from "react";
import { useAuth } from "@/app/contexts/AuthContext";
import { useDocumentWorkspace } from "@/app/contexts/WorkspaceContext";
import { currentAuthEpoch, subscribeAuthEpoch } from "@/app/lib/authEvents";
import { workspaceIdentityKey } from "@mike/client";

/** Ephemeral callbacks belong to the original account/session and content workspace. */
export function useWorkspaceIdentity(): string {
  const { user } = useAuth();
  const epoch = useSyncExternalStore(subscribeAuthEpoch, currentAuthEpoch, () => 0);
  // Upstream divergence (sync-log: 25c76a81): upstream keys only on the shared
  // workspaceIdentityKey(account, workspace). Dev also keys on the auth epoch so
  // a callback captured before a sign-out/sign-in never runs for the new session.
  const identity = workspaceIdentityKey(user?.id, useDocumentWorkspace());
  return JSON.stringify([epoch, identity]);
}
