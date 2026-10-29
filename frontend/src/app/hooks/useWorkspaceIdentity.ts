"use client";

import { useSyncExternalStore } from "react";
import { useAuth } from "@/app/contexts/AuthContext";
import { useDocumentWorkspace } from "@/app/contexts/WorkspaceContext";
import { currentAuthEpoch, subscribeAuthEpoch } from "@/app/lib/authEvents";

/** Ephemeral callbacks belong to the original account/session and content workspace. */
export function useWorkspaceIdentity(): string {
  const { user } = useAuth();
  const epoch = useSyncExternalStore(subscribeAuthEpoch, currentAuthEpoch, () => 0);
  const workspace = useDocumentWorkspace() ?? "personal";
  return JSON.stringify([epoch, user?.id ?? null, workspace]);
}
