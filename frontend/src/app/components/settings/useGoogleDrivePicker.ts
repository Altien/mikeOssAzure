"use client";

import { useCallback, useState, useRef, useEffect } from "react";
import {
  createGoogleDrivePickerSession,
  isMfaRequiredError,
} from "@/app/lib/mikeApi";
import { useRequestOwner } from "@/app/hooks/useRequestOwner";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import { openGoogleDrivePicker } from "@/app/lib/googlePicker";
import { userFacingApiError } from "@/app/lib/userFacingError";

/**
 * "Add files from Google Drive": fetch a short-lived token, open Google's
 * Picker, and describe the outcome in one plain sentence. Picking is itself
 * the grant, so there is nothing to save afterwards.
 *
 * An MFA challenge is rethrown so the page's step-up flow can retry the
 * action; every other failure becomes the status message.
 */
export function useGoogleDrivePicker() {
  const owner = useRequestOwner();
  const { workspaceId } = useWorkspace();
  const abort = useRef<AbortController | null>(null);
  useEffect(() => { setMessage(null); return () => abort.current?.abort(); }, [owner.key]);
  const [message, setMessage] = useState<string | null>(null);

  const addFiles = useCallback(async () => {
    const isCurrent = owner.capture();
    if (!isCurrent() || (workspaceId !== null && workspaceId !== "personal")) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setMessage(null);
    try {
      const picked = await openGoogleDrivePicker(
        await createGoogleDrivePickerSession(isCurrent),
        { isCurrent, signal: controller.signal },
      );
      if (!isCurrent() || controller.signal.aborted) return;
      setMessage(
        picked.length
          ? `Added ${picked.length} ${picked.length === 1 ? "file" : "files"}. Mike can now search and read them.`
          : "No files added.",
      );
    } catch (error) {
      if (!isCurrent() || controller.signal.aborted) return;
      if (isMfaRequiredError(error)) throw error;
      setMessage(
        userFacingApiError(
          error,
          "Google Drive could not be opened. Try again.",
        ),
      );
    }
  }, [owner.capture, workspaceId]);

  return { addFiles, message };
}
