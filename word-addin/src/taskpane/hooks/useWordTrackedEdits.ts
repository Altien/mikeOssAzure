import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  releaseTrackedEdits,
  revealProposedEdit,
  resolveTrackedEdit,
  resolveTrackedEdits,
  restoreTrackedEdits,
  revealPersistedTrackedEdit,
  revealTrackedEdit,
  validateTrackedEdit,
  useWordDoc,
} from "./useWordDoc";
import type { TrackedEditHandle } from "./useWordDoc";
import type { Message as SavedMessage } from "../types";
import { projectRedlineStream } from "../lib/redline";
import type { RedlineEdit, StreamingRedlineEdit } from "../lib/redline";

/**
 * Shape a sealed streamed block for `applyTrackedEdits`. Returns null for a
 * block that carries neither a replacement nor a usable format list — such a
 * block is never safe to apply.
 */
function toRedlineEdit(edit: StreamingRedlineEdit): RedlineEdit | null {
  const isFormatEdit = !!edit.format && edit.format.length > 0;
  if (edit.replacement === undefined && !isFormatEdit) return null;
  return {
    original: edit.original,
    replacement: edit.replacement ?? "",
    ...(isFormatEdit ? { format: edit.format } : {}),
    ...(edit.occurrence ? { occurrence: edit.occurrence } : {}),
    ...(edit.reason ? { reason: edit.reason } : {}),
  };
}

type TrackedEditApplyOutcome = Awaited<
  ReturnType<ReturnType<typeof useWordDoc>["applyTrackedEdits"]>
>["edits"][number];

function editFailureState(result: {
  status: string;
  reason?: string;
  error?: string;
}): Pick<EditRuntimeState, "status" | "error"> {
  if (result.status === "error") {
    return { status: "error", error: result.error };
  }
  if (result.reason === "ambiguous") {
    return { status: "ambiguous", error: result.error };
  }
  if (result.status === "not-found") {
    return {
      status: "skipped",
      error: "Skipped — the source text could not be found in the document.",
    };
  }
  if (result.reason === "unsearchable") {
    return {
      status: "unsearchable",
      error: "Skipped — this passage cannot be safely located in the document.",
    };
  }
  if (result.reason === "pre-existing-revisions") {
    return {
      status: "conflicted",
      error: result.error,
    };
  }
  return { status: "skipped", error: result.error };
}
import type {
  EditDecision,
  EditRuntimeState,
  WordEditStreamController,
  WordTrackedEditsController,
} from "../lib/wordChatTypes";
import type { WordEditApplyMode } from "../lib/wordChatSettings";
import { getEditKey } from "../lib/wordTrackedEditKeys";
import { listWordEditAnchorIds } from "../lib/wordEditAnchors";

export function useWordTrackedEdits({
  sessionKey,
  initialMessages,
  applyMode = "approval",
}: {
  sessionKey: number;
  initialMessages: SavedMessage[];
  applyMode?: WordEditApplyMode;
}): WordTrackedEditsController {
  const [editStateByKey, setEditStateByKey] = useState<
    Record<string, EditRuntimeState>
  >({});
  const mountedRef = useRef(true);
  const sessionGenerationRef = useRef(0);
  const scheduledEditKeysRef = useRef(new Set<string>());
  const editApplyJobsRef = useRef(new Map<string, Promise<void>>());
  // One card can own several Word handles: a replace-all edit retains one
  // per applied occurrence, resolved together.
  const editHandlesRef = useRef(new Map<string, TrackedEditHandle[]>());
  // Review-mode proposals remain non-mutating until the user clicks Apply.
  const readyEditsRef = useRef(
    new Map<string, { edit: RedlineEdit; persistent: boolean }>(),
  );
  // Card key → the stable edit ID whose document bookmark backs "View" after
  // a reload (a replace-all card's first restored pass, else the key itself).
  const persistentViewEditKeysRef = useRef(new Map<string, string>());
  const resolvingEditKeysRef = useRef(new Set<string>());
  // Read at apply time so a mid-stream toggle governs only edits that have
  // not been scheduled yet; already-applied cards keep their lifecycle.
  const applyModeRef = useRef(applyMode);
  applyModeRef.current = applyMode;
  const { applyTrackedEdits, acceptPendingRevisionsForEdit } = useWordDoc();
  // Conflicted cards keep their full apply arguments so "Accept & apply"
  // can accept the occupying revisions and rerun the same lifecycle.
  const conflictedRetryRef = useRef(
    new Map<
      string,
      {
        edit: RedlineEdit;
        persistent: boolean;
      }
    >(),
  );

  const setEditRuntimeState = useCallback(
    (key: string, patch: Partial<EditRuntimeState>): void => {
      setEditStateByKey((current) => {
        const previous = current[key];
        return {
          ...current,
          [key]: {
            ...previous,
            ...patch,
            status: patch.status ?? previous?.status ?? "receiving",
          },
        };
      });
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sessionGenerationRef.current += 1;
      const handles = [...editHandlesRef.current.values()].flat();
      editHandlesRef.current.clear();
      readyEditsRef.current.clear();
      editApplyJobsRef.current.clear();
      persistentViewEditKeysRef.current.clear();
      resolvingEditKeysRef.current.clear();
      conflictedRetryRef.current.clear();
      if (handles.length > 0) void releaseTrackedEdits(handles);
    };
  }, []);

  useEffect(() => {
    sessionGenerationRef.current += 1;
    const generation = sessionGenerationRef.current;
    const staleHandles = [...editHandlesRef.current.values()].flat();
    editHandlesRef.current.clear();
    readyEditsRef.current.clear();
    if (staleHandles.length > 0) void releaseTrackedEdits(staleHandles);
    scheduledEditKeysRef.current.clear();
    editApplyJobsRef.current.clear();
    persistentViewEditKeysRef.current.clear();
    resolvingEditKeysRef.current.clear();
    conflictedRetryRef.current.clear();
    setEditStateByKey({});

    const descriptors: {
      cardKey: string;
      stableEditId: string;
      edit: RedlineEdit;
    }[] = [];
    for (const message of initialMessages) {
      if (message.role !== "assistant" || !message.id) continue;
      const projection = projectRedlineStream(message.content, true);
      for (const edit of projection.edits) {
        if (!edit.sealed) continue;
        const sealedEdit = toRedlineEdit(edit);
        if (!sealedEdit) continue;
        const cardKey = getEditKey(message.id, edit.blockIndex);
        if (sealedEdit.occurrence === "all") {
          // A replace-all edit persisted one bookmark per applied pass under
          // `${cardKey}#${pass}`; the anchor registry says how many. When
          // the registry is unavailable, probe the first few deterministic
          // ids — a missing bookmark is a cheap not-found in the batch.
          let passIds: string[] = [];
          try {
            passIds = listWordEditAnchorIds(`${cardKey}#`);
          } catch {
            passIds = [];
          }
          if (passIds.length === 0) {
            passIds = Array.from({ length: 8 }, (_, i) => `${cardKey}#${i}`);
          }
          passIds.sort(
            (a, b) =>
              Number(a.split("#").pop() ?? 0) - Number(b.split("#").pop() ?? 0),
          );
          for (const stableEditId of passIds) {
            descriptors.push({ cardKey, stableEditId, edit: sealedEdit });
          }
          continue;
        }
        descriptors.push({ cardKey, stableEditId: cardKey, edit: sealedEdit });
      }
    }
    if (descriptors.length === 0) return;

    setEditStateByKey((current) => {
      const next = { ...current };
      for (const { cardKey } of descriptors) {
        next[cardKey] = { status: "restoring", busy: true };
      }
      return next;
    });

    // One batched restore: every bookmark lookup shares a single Word.run
    // behind the global mutation queue, instead of ~4 serialized syncs per
    // stored edit. The batch keeps per-edit failure isolation internally.
    void (async () => {
      const results = await restoreTrackedEdits(
        descriptors.map(({ stableEditId, edit }) => ({ stableEditId, edit })),
      );
      if (!mountedRef.current || generation !== sessionGenerationRef.current) {
        const staleHandles = results.flatMap((result) =>
          result.handle ? [result.handle] : [],
        );
        if (staleHandles.length > 0) await releaseTrackedEdits(staleHandles);
        return;
      }

      // Aggregate per card: a replace-all card owns several pass results,
      // and any restored pass keeps the whole card actionable.
      interface CardRestoreBucket {
        handles: TrackedEditHandle[];
        viewId?: string;
        anyViewOnly: boolean;
        firstError?: string;
      }
      const byCard = new Map<string, CardRestoreBucket>();
      results.forEach((result, resultIndex) => {
        const descriptor = descriptors[resultIndex];
        if (!descriptor) return;
        const bucket = byCard.get(descriptor.cardKey) ?? {
          handles: [],
          anyViewOnly: false,
        };
        if (result.status === "restored" && result.handle) {
          bucket.handles.push(result.handle);
          bucket.viewId ??= descriptor.stableEditId;
        } else if (result.status === "view-only") {
          bucket.anyViewOnly = true;
          bucket.viewId ??= descriptor.stableEditId;
        }
        if (result.error) bucket.firstError ??= result.error;
        byCard.set(descriptor.cardKey, bucket);
      });

      for (const [cardKey, bucket] of byCard) {
        if (bucket.handles.length > 0) {
          editHandlesRef.current.set(cardKey, bucket.handles);
          persistentViewEditKeysRef.current.set(
            cardKey,
            bucket.viewId ?? cardKey,
          );
          setEditRuntimeState(cardKey, {
            status: "pending",
            busy: false,
            error: undefined,
          });
          continue;
        }
        if (bucket.anyViewOnly) {
          persistentViewEditKeysRef.current.set(
            cardKey,
            bucket.viewId ?? cardKey,
          );
          setEditRuntimeState(cardKey, {
            status: "view-only",
            busy: false,
            error: undefined,
          });
          continue;
        }
        setEditRuntimeState(cardKey, {
          status: "historical",
          busy: false,
          error: bucket.firstError,
        });
      }
    })();
    // sessionKey is the explicit boundary for historical restoration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  const beginApplyingEdit = useCallback(
    (
      key: string,
      edit: RedlineEdit,
      persistent: boolean,
      keepCardVisible = false,
    ): void => {
      readyEditsRef.current.delete(key);
      conflictedRetryRef.current.delete(key);
      setEditRuntimeState(key, {
        status: keepCardVisible ? "applying-approved" : "applying",
        busy: true,
      });
      const generation = sessionGenerationRef.current;

      const replaceAll = edit.occurrence === "all";
      // Runaway guard only: a real replace-all finishes when a pass reports
      // zero remaining revision-free occurrences.
      const MAX_REPLACE_ALL_PASSES = 50;

      const job = (async (): Promise<void> => {
        const abandoned = (): boolean =>
          generation !== sessionGenerationRef.current || !mountedRef.current;

        // A replace-all edit applies one occurrence per call (last match
        // first — see applyTrackedEdits) and every pass retains its own
        // handle; a single edit runs exactly one pass.
        const handles: TrackedEditHandle[] = [];
        let first: TrackedEditApplyOutcome | null = null;
        let last: TrackedEditApplyOutcome | null = null;
        let warning: string | undefined;
        let pass = 0;
        for (;;) {
          const report = await applyTrackedEdits([
            {
              ...edit,
              ...(persistent
                ? { stableEditId: replaceAll ? `${key}#${pass}` : key }
                : {}),
            },
          ]);
          const result = report.edits[0];
          if (!result) {
            throw new Error("Word did not return an edit result.");
          }
          warning = report.warning ?? warning;
          if (result.handle) handles.push(result.handle);
          first ??= result;
          last = result;
          if (abandoned()) {
            if (handles.length > 0) await releaseTrackedEdits(handles);
            return;
          }
          pass += 1;
          if (
            !replaceAll ||
            result.status !== "applied" ||
            (result.remainingTargets ?? 0) === 0 ||
            pass >= MAX_REPLACE_ALL_PASSES
          ) {
            break;
          }
        }
        if (!first || !last) {
          throw new Error("Word did not return an edit result.");
        }

        const appliedCount = handles.length;
        const matchesFound = first.matches;
        // A replace-all card cannot summarize several paragraphs in one
        // snippet; only a uniquely-located edit keeps its hint.
        const locationHint =
          matchesFound === 1 ? first.locationHint : undefined;
        const remainingAfterLast =
          last.status === "applied" ? (last.remainingTargets ?? 0) : 0;
        const partialError =
          replaceAll &&
          appliedCount > 0 &&
          (last.status !== "applied" || remainingAfterLast > 0)
            ? `Applied ${appliedCount} of ${matchesFound} occurrences; the rest couldn’t be applied.`
            : undefined;

        if (appliedCount > 0) {
          editHandlesRef.current.set(key, handles);
          if (first.persistentAnchor) {
            persistentViewEditKeysRef.current.set(
              key,
              persistent && replaceAll ? `${key}#0` : key,
            );
          }
          setEditRuntimeState(key, {
            status: "pending",
            matches: matchesFound,
            appliedMatches: appliedCount,
            locationHint,
            busy: false,
            error: partialError ?? first.error ?? warning,
          });
          return;
        }

        if (first.status === "applied-unmanaged") {
          setEditRuntimeState(key, {
            status: "unmanaged",
            matches: matchesFound,
            locationHint,
            busy: false,
            error: first.error ?? warning,
          });
          return;
        }
        if (first.reason === "pre-existing-revisions") {
          conflictedRetryRef.current.set(key, {
            edit,
            persistent,
          });
        }
        setEditRuntimeState(key, {
          status:
            first.status === "error"
              ? "error"
              : first.reason === "ambiguous"
                ? "ambiguous"
                : first.reason === "unsearchable"
                  ? "unsearchable"
                  : first.reason === "pre-existing-revisions"
                    ? "conflicted"
                    : "skipped",
          matches: matchesFound,
          busy: false,
          error: first.error,
        });
      })().catch((error: unknown) => {
        if (
          generation !== sessionGenerationRef.current ||
          !mountedRef.current
        ) {
          return;
        }
        setEditRuntimeState(key, {
          status: "error",
          busy: false,
          error:
            error instanceof Error
              ? error.message
              : "Word couldn't apply this change.",
        });
      });
      editApplyJobsRef.current.set(key, job);
      void job.finally(() => {
        if (editApplyJobsRef.current.get(key) === job) {
          editApplyJobsRef.current.delete(key);
        }
      });
    },
    [applyTrackedEdits, setEditRuntimeState],
  );

  const scheduleDirectEdit = useCallback(
    (
      messageId: string,
      editIndex: number,
      edit: RedlineEdit,
      persistent: boolean,
    ): void => {
      const key = getEditKey(messageId, editIndex);
      if (scheduledEditKeysRef.current.has(key)) return;
      scheduledEditKeysRef.current.add(key);
      beginApplyingEdit(key, edit, persistent);
    },
    [beginApplyingEdit],
  );

  const scheduleReviewEdit = useCallback(
    (
      messageId: string,
      editIndex: number,
      edit: RedlineEdit,
      persistent: boolean,
    ): void => {
      const key = getEditKey(messageId, editIndex);
      if (scheduledEditKeysRef.current.has(key)) return;
      scheduledEditKeysRef.current.add(key);
      setEditRuntimeState(key, { status: "validating", busy: true });
      const generation = sessionGenerationRef.current;
      const job = validateTrackedEdit(edit)
        .then((result) => {
          if (
            generation !== sessionGenerationRef.current ||
            !mountedRef.current
          ) {
            return;
          }
          if (result.status === "ready") {
            readyEditsRef.current.set(key, { edit, persistent });
            setEditRuntimeState(key, {
              status: "ready",
              matches: result.matches,
              busy: false,
              error: undefined,
              viewError: undefined,
            });
            return;
          }
          if (result.reason === "pre-existing-revisions") {
            conflictedRetryRef.current.set(key, { edit, persistent });
          }
          setEditRuntimeState(key, {
            ...editFailureState(result),
            matches: result.matches,
            busy: false,
          });
        })
        .catch((error: unknown) => {
          if (
            generation !== sessionGenerationRef.current ||
            !mountedRef.current
          ) {
            return;
          }
          setEditRuntimeState(key, {
            status: "error",
            busy: false,
            error:
              error instanceof Error
                ? error.message
                : "Word couldn't check whether this change can be applied.",
          });
        });
      editApplyJobsRef.current.set(key, job);
      void job.finally(() => {
        if (editApplyJobsRef.current.get(key) === job) {
          editApplyJobsRef.current.delete(key);
        }
      });
    },
    [setEditRuntimeState],
  );

  const applyReadyEdit = useCallback(
    (key: string): void => {
      const ready = readyEditsRef.current.get(key);
      if (
        !ready ||
        editApplyJobsRef.current.has(key) ||
        resolvingEditKeysRef.current.has(key)
      ) {
        return;
      }
      beginApplyingEdit(key, ready.edit, ready.persistent, true);
    },
    [beginApplyingEdit],
  );

  const waitForMessageEdits = useCallback(
    async (messageId: string): Promise<void> => {
      const prefix = `${messageId}:edit-`;
      const jobs = [...editApplyJobsRef.current.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, job]) => job);
      if (jobs.length > 0) await Promise.all(jobs);
    },
    [],
  );

  const processLiveRedlines = useCallback(
    (
      messageId: string,
      content: string,
      streamComplete: boolean,
      persistent: boolean,
    ): void => {
      const projection = projectRedlineStream(content, streamComplete);
      setEditStateByKey((current) => {
        let changed = false;
        const next = { ...current };
        projection.edits.forEach((edit) => {
          const key = getEditKey(messageId, edit.blockIndex);
          if (!next[key]) {
            next[key] = { status: "receiving" };
            changed = true;
          }
        });
        return changed ? next : current;
      });

      projection.edits.forEach((edit) => {
        if (!edit.sealed) return;
        const sealedEdit = toRedlineEdit(edit);
        if (!sealedEdit) return;
        if (applyModeRef.current === "direct") {
          scheduleDirectEdit(
            messageId,
            edit.blockIndex,
            sealedEdit,
            persistent,
          );
        } else {
          scheduleReviewEdit(
            messageId,
            edit.blockIndex,
            sealedEdit,
            persistent,
          );
        }
      });
    },
    [scheduleDirectEdit, scheduleReviewEdit],
  );

  const markIncompleteRedlines = useCallback(
    (messageId: string, content: string): void => {
      const projection = projectRedlineStream(content, false);
      projection.edits.forEach((edit) => {
        const key = getEditKey(messageId, edit.blockIndex);
        if (!edit.sealed && !scheduledEditKeysRef.current.has(key)) {
          setEditRuntimeState(key, {
            status: "incomplete",
            busy: false,
            error: undefined,
          });
        }
      });
    },
    [setEditRuntimeState],
  );

  /**
   * The conflicted card's "Accept & apply": accept the pending revisions
   * occupying the edit's target, then rerun the edit's normal apply
   * lifecycle from scratch. Two explicit steps — never a layered redline —
   * so a card's Accept/Reject always resolves exactly the revisions it
   * created, and the embedded pending changes are resolved only on an
   * explicit user click, never by a streaming model.
   */
  const acceptAndApplyEdit = useCallback(
    async (key: string): Promise<void> => {
      const retry = conflictedRetryRef.current.get(key);
      if (!retry || resolvingEditKeysRef.current.has(key)) return;
      const generation = sessionGenerationRef.current;
      resolvingEditKeysRef.current.add(key);
      setEditRuntimeState(key, {
        status: "applying",
        busy: true,
        error: undefined,
      });
      try {
        const outcome = await acceptPendingRevisionsForEdit(retry.edit);
        if (
          generation !== sessionGenerationRef.current ||
          !mountedRef.current
        ) {
          return;
        }
        if ("error" in outcome) {
          setEditRuntimeState(key, {
            status: "conflicted",
            busy: false,
            error: outcome.error,
          });
          return;
        }
        conflictedRetryRef.current.delete(key);
        beginApplyingEdit(key, retry.edit, retry.persistent, true);
      } finally {
        resolvingEditKeysRef.current.delete(key);
      }
    },
    [acceptPendingRevisionsForEdit, beginApplyingEdit, setEditRuntimeState],
  );

  const viewEdit = useCallback(
    async (key: string): Promise<void> => {
      const ready = readyEditsRef.current.get(key);
      if (ready) {
        if (resolvingEditKeysRef.current.has(key)) return;
        resolvingEditKeysRef.current.add(key);
        const generation = sessionGenerationRef.current;
        setEditRuntimeState(key, {
          busy: true,
          error: undefined,
          viewError: undefined,
        });
        try {
          const result = await revealProposedEdit(ready.edit);
          if (
            !mountedRef.current ||
            generation !== sessionGenerationRef.current
          ) {
            return;
          }
          if (result.status === "not-found") {
            readyEditsRef.current.delete(key);
            setEditRuntimeState(key, {
              status: "skipped",
              busy: false,
              error:
                "Skipped — the source text could not be found in the document.",
            });
            return;
          }
          if (result.status === "ambiguous") {
            readyEditsRef.current.delete(key);
            setEditRuntimeState(key, {
              status: "ambiguous",
              busy: false,
              error: undefined,
            });
            return;
          }
          setEditRuntimeState(key, {
            status: "ready",
            busy: false,
            viewError:
              result.status === "revealed"
                ? undefined
                : (result.error ??
                  "Word couldn’t scroll to this proposed change."),
          });
        } finally {
          resolvingEditKeysRef.current.delete(key);
        }
        return;
      }
      const handles = editHandlesRef.current.get(key) ?? [];
      const firstHandle = handles[0];
      const persistentViewId = persistentViewEditKeysRef.current.get(key);
      if (!firstHandle && !persistentViewId) return;
      const generation = sessionGenerationRef.current;
      const result = persistentViewId
        ? await revealPersistedTrackedEdit(persistentViewId)
        : await revealTrackedEdit(firstHandle as TrackedEditHandle);
      if (!mountedRef.current || generation !== sessionGenerationRef.current) {
        return;
      }
      if (result.status === "not-found" || result.status === "resolved") {
        persistentViewEditKeysRef.current.delete(key);
        if (handles.length > 0) {
          editHandlesRef.current.delete(key);
          void releaseTrackedEdits(handles);
        }
        setEditRuntimeState(key, {
          status: "historical",
          busy: false,
          viewError:
            "Word no longer reports a pending revision for this change.",
        });
        return;
      }
      setEditRuntimeState(key, {
        viewError:
          result.status === "revealed"
            ? undefined
            : (result.error ??
              "Word couldn’t scroll to this change. Find it in Word’s Review tab."),
      });
    },
    [setEditRuntimeState],
  );

  const resolveOneEdit = useCallback(
    async (key: string, decision: EditDecision): Promise<void> => {
      const handles = editHandlesRef.current.get(key) ?? [];
      if (handles.length === 0 || resolvingEditKeysRef.current.has(key)) {
        return;
      }
      const generation = sessionGenerationRef.current;
      resolvingEditKeysRef.current.add(key);
      setEditRuntimeState(key, {
        busy: true,
        error: undefined,
        viewError: undefined,
      });

      try {
        if (handles.length === 1) {
          const handle = handles[0] as TrackedEditHandle;
          const result = await resolveTrackedEdit(handle, decision);
          if (
            !mountedRef.current ||
            generation !== sessionGenerationRef.current
          ) {
            return;
          }
          if (result.status === "accepted" || result.status === "rejected") {
            editHandlesRef.current.delete(key);
            persistentViewEditKeysRef.current.delete(key);
            setEditRuntimeState(key, {
              status: result.status,
              busy: false,
              error: undefined,
            });
          } else if (
            result.status === "already-resolved" &&
            result.resolvedAs
          ) {
            editHandlesRef.current.delete(key);
            persistentViewEditKeysRef.current.delete(key);
            setEditRuntimeState(key, {
              status: result.resolvedAs === "accept" ? "accepted" : "rejected",
              busy: false,
              error: undefined,
            });
          } else {
            if (result.status === "error" && result.handle !== handle) {
              editHandlesRef.current.set(key, [result.handle]);
              setEditRuntimeState(key, {
                status: "pending",
                busy: false,
                error: result.error,
              });
            } else {
              editHandlesRef.current.delete(key);
              setEditRuntimeState(key, {
                status: "error",
                busy: false,
                error:
                  result.error ?? "The tracked change is no longer available.",
              });
            }
          }
          return;
        }

        // Replace-all card: every retained occurrence resolves together as
        // one decision. Anything short of a uniform terminal outcome hands
        // review back to Word rather than pretending a partial decision.
        const results = await resolveTrackedEdits(handles, decision);
        if (
          !mountedRef.current ||
          generation !== sessionGenerationRef.current
        ) {
          return;
        }
        editHandlesRef.current.delete(key);
        persistentViewEditKeysRef.current.delete(key);
        const decisionOf = (
          result: (typeof results)[number],
        ): "accept" | "reject" | null =>
          result.status === "accepted"
            ? "accept"
            : result.status === "rejected"
              ? "reject"
              : result.status === "already-resolved" && result.resolvedAs
                ? result.resolvedAs
                : null;
        const decisions = results.map(decisionOf);
        if (decisions.every((entry) => entry === "accept")) {
          setEditRuntimeState(key, {
            status: "accepted",
            busy: false,
            error: undefined,
          });
        } else if (decisions.every((entry) => entry === "reject")) {
          setEditRuntimeState(key, {
            status: "rejected",
            busy: false,
            error: undefined,
          });
        } else {
          setEditRuntimeState(key, {
            status: "error",
            busy: false,
            error:
              results.find((result) => result.error)?.error ??
              "Some of this edit’s tracked changes are no longer available. Review them from Word’s Review tab.",
          });
        }
      } catch (error) {
        if (
          !mountedRef.current ||
          generation !== sessionGenerationRef.current
        ) {
          return;
        }
        setEditRuntimeState(key, {
          status: "error",
          busy: false,
          error:
            error instanceof Error
              ? error.message
              : "Word couldn't update the tracked change.",
        });
      } finally {
        resolvingEditKeysRef.current.delete(key);
      }
    },
    [setEditRuntimeState],
  );

  const resolveMessageEdits = useCallback(
    async (editKeys: string[], decision: EditDecision): Promise<void> => {
      const generation = sessionGenerationRef.current;
      const entries = editKeys
        .map((key) => ({
          key,
          handles: editHandlesRef.current.get(key) ?? [],
        }))
        .filter(
          (entry) =>
            entry.handles.length > 0 &&
            !resolvingEditKeysRef.current.has(entry.key),
        );
      if (entries.length === 0) return;

      for (const entry of entries) {
        resolvingEditKeysRef.current.add(entry.key);
        setEditRuntimeState(entry.key, {
          busy: true,
          error: undefined,
          viewError: undefined,
        });
      }

      try {
        // One flat resolution pass; results group back per card so a
        // replace-all card's occurrences share one verdict.
        const flat = entries.flatMap((entry) =>
          entry.handles.map((handle) => ({ key: entry.key, handle })),
        );
        const results = await resolveTrackedEdits(
          flat.map((item) => item.handle),
          decision,
        );
        if (
          !mountedRef.current ||
          generation !== sessionGenerationRef.current
        ) {
          return;
        }
        const decisionOf = (
          result: (typeof results)[number],
        ): "accept" | "reject" | null =>
          result.status === "accepted"
            ? "accept"
            : result.status === "rejected"
              ? "reject"
              : result.status === "already-resolved" && result.resolvedAs
                ? result.resolvedAs
                : null;
        for (const entry of entries) {
          const cardResults = results.filter(
            (_result, index) => flat[index]?.key === entry.key,
          );
          editHandlesRef.current.delete(entry.key);
          const decisions = cardResults.map(decisionOf);
          if (decisions.every((item) => item === "accept")) {
            persistentViewEditKeysRef.current.delete(entry.key);
            setEditRuntimeState(entry.key, {
              status: "accepted",
              busy: false,
              error: undefined,
            });
          } else if (decisions.every((item) => item === "reject")) {
            persistentViewEditKeysRef.current.delete(entry.key);
            setEditRuntimeState(entry.key, {
              status: "rejected",
              busy: false,
              error: undefined,
            });
          } else {
            setEditRuntimeState(entry.key, {
              status: "error",
              busy: false,
              error:
                cardResults.find((result) => result.error)?.error ??
                "The tracked change is no longer available.",
            });
          }
        }
      } catch (error) {
        if (
          !mountedRef.current ||
          generation !== sessionGenerationRef.current
        ) {
          return;
        }
        for (const entry of entries) {
          setEditRuntimeState(entry.key, {
            status: "error",
            busy: false,
            error:
              error instanceof Error
                ? error.message
                : "Word couldn't update the tracked changes.",
          });
        }
      } finally {
        for (const entry of entries) {
          resolvingEditKeysRef.current.delete(entry.key);
        }
      }
    },
    [setEditRuntimeState],
  );

  // handleChat lists the stream controller among its deps. Handing it an
  // object that also carries editStateByKey would recreate handleChat on
  // every receiving→applying→pending transition mid-stream — exactly the
  // churn the chat hook's message refs exist to prevent — so the behavior is
  // memoized apart from the state it drives.
  const streamController = useMemo<WordEditStreamController>(
    () => ({
      processLiveRedlines,
      markIncompleteRedlines,
      waitForMessageEdits,
    }),
    [markIncompleteRedlines, processLiveRedlines, waitForMessageEdits],
  );

  return {
    editStateByKey,
    streamController,
    applyEdit: applyReadyEdit,
    viewEdit,
    resolveOneEdit,
    resolveMessageEdits,
    acceptAndApplyEdit,
  };
}
