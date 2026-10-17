"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  updatePlaybook,
  type Playbook,
  type PlaybookContent,
} from "@/app/lib/mikeApi";
import { useRequestOwner } from "@/app/hooks/useRequestOwner";
import { notifyError } from "@/app/lib/userFacingError";

type Change = {
  id: string;
  content: PlaybookContent;
  access: Pick<Playbook, "visibility">;
};

/** Serialize writes so a slow response cannot overwrite more recent typing. */
export function usePlaybookAutosave(onSaved: (playbook: Playbook) => void) {
  const owner = useRequestOwner();
  const isCurrent = useRef(owner.capture()).current;
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  // The workspace survives navigation between playbooks. Coalesce typing
  // within one playbook without discarding another playbook's trailing edit.
  const pending = useRef(new Map<string, Change>());
  const running = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedCallback = useRef(onSaved);
  useEffect(() => {
    savedCallback.current = onSaved;
  }, [onSaved]);

  // Match the workflow editor: acknowledge a completed save briefly. Cleanup
  // prevents that acknowledgement from hiding a later save or failure.
  useEffect(() => {
    if (status !== "saved") return;
    const timeout = setTimeout(() => setStatus("idle"), 2000);
    return () => clearTimeout(timeout);
  }, [status]);

  const flush = useCallback(function flush(): Promise<boolean> {
    if (timer.current) clearTimeout(timer.current);
    if (!isCurrent()) { pending.current.clear(); return Promise.resolve(false); }
    if (running.current) return running.current;
    if (!pending.current.size) return Promise.resolve(true);
    setStatus("saving");
    running.current = (async () => {
      try {
        while (pending.current.size) {
          const change = pending.current.values().next().value!;
          const saved = await updatePlaybook(
            change.id,
            change.content,
            change.access,
            isCurrent,
          );
          if (!isCurrent()) return false;
          if (pending.current.get(change.id) === change) {
            pending.current.delete(change.id);
            savedCallback.current(saved);
          }
        }
        setStatus("saved");
        return true;
      } catch (error) {
        if (!isCurrent()) return false;
        setStatus("error");
        notifyError(error, {
          action: "save your playbook",
          dedupeKey: `playbook-autosave:${pending.current.keys().next().value}`,
          onRetry: () => {
            if (isCurrent()) void flush();
          },
        });
        return false;
      } finally {
        running.current = null;
      }
    })();
    return running.current;
  }, []);

  const schedule = useCallback(
    (change: Change) => {
      if (!isCurrent()) return;
      pending.current.set(change.id, change);
      setStatus("saving");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void flush();
      }, 800);
    },
    [flush],
  );

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!pending.current.size) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      // Internal navigation must not discard the trailing debounce.
      void flush();
    };
  }, [flush]);

  return { status, schedule, flush, resetStatus: () => setStatus("idle") };
}
