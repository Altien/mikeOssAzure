"use client";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useAuth } from "@/app/contexts/AuthContext";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import { currentAuthEpoch, subscribeAuthEpoch } from "@/app/lib/authEvents";

/** Fence audit/recovery work before credentials, requests and response effects. */
export function useRequestOwner(orgId?: string) {
  const { user } = useAuth();
  const { workspaceId } = useWorkspace();
  const epoch = useSyncExternalStore(subscribeAuthEpoch, currentAuthEpoch, () => 0);
  const key = JSON.stringify([epoch, user?.id, workspaceId, orgId]);
  const owner = useRef(key);
  owner.current = key;
  useEffect(() => {
    owner.current = key;
    return () => { if (owner.current === key) owner.current = "disposed"; };
  }, [key]);
  const capture = useCallback(() => {
    const captured = key;
    return () => Boolean(user?.id) && owner.current === captured && currentAuthEpoch() === epoch
      && (!orgId || workspaceId === null || workspaceId === orgId);
  }, [key, user?.id, epoch, orgId, workspaceId]);
  return { key, capture };
}
