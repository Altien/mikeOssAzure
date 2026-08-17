/// <reference types="office-js" />

import { useCallback } from "react";
import { toWordText } from "../lib/wordText";
import type { RedlineEdit } from "../lib/redline";
import { isParagraphStyleFormat } from "../lib/redline";
import { createSecureUuid } from "../lib/secureUuid";
import {
  bookmarkNameForEdit,
  getWordEditAnchor,
  persistWordEditAnchor,
  removeWordEditAnchor,
} from "../lib/wordEditAnchors";

interface PersistedRedlineEdit extends RedlineEdit {
  /** Stable `${assistantMessageId}:edit-${blockIndex}` identity. */
  stableEditId?: string;
}

interface RedlineApplyReport {
  /** One lifecycle result for every logical edit supplied by the caller. */
  edits: TrackedEditApplyResult[];
  /** Non-fatal host warning, such as failing to restore tracking mode. */
  warning?: string;
}

declare const trackedEditHandleBrand: unique symbol;

/**
 * An in-memory reference to only the Word revisions created for one logical
 * Mike edit. Callers must treat the string as opaque.
 */
export type TrackedEditHandle = string & {
  readonly [trackedEditHandleBrand]: true;
};

type TrackedEditApplyStatus =
  | "applied"
  | "applied-unmanaged"
  | "skipped"
  | "not-found"
  | "error";

type TrackedEditApplyReason =
  | "unsearchable"
  | "ambiguous"
  | "pre-existing-revisions"
  | "no-tracked-changes"
  | "unexpected-revisions"
  | "word-error";

/** Result for one logical ORIGINAL/REPLACEMENT edit. */
interface TrackedEditApplyResult {
  index: number;
  original: string;
  replacement: string;
  status: TrackedEditApplyStatus;
  /** Number of exact document occurrences Word found. */
  matches: number;
  /** Number of occurrences replaced when status is `applied`. */
  appliedMatches: number;
  /** Present only when exact generated revisions were retained successfully. */
  handle?: TrackedEditHandle;
  /** A hidden Word bookmark was inserted for reload-safe navigation. */
  persistentAnchor?: boolean;
  reason?: TrackedEditApplyReason;
  error?: string;
}

type TrackedEditDecision = "accept" | "reject";

type TrackedEditResolutionStatus =
  | "accepted"
  | "rejected"
  | "already-resolved"
  | "released"
  | "not-found"
  | "error";

interface TrackedEditResolutionResult {
  handle: TrackedEditHandle;
  status: TrackedEditResolutionStatus;
  resolvedAs?: TrackedEditDecision;
  error?: string;
}

type TrackedEditRevealStatus =
  | "revealed"
  | "already-resolved"
  | "released"
  | "not-found"
  | "error";

interface TrackedEditRevealResult {
  handle: TrackedEditHandle;
  status: TrackedEditRevealStatus;
  resolvedAs?: TrackedEditDecision;
  error?: string;
}

type TrackedEditRestoreStatus =
  | "restored"
  | "view-only"
  | "not-found"
  | "resolved"
  | "error";

interface TrackedEditRestoreResult {
  stableEditId: string;
  status: TrackedEditRestoreStatus;
  handle?: TrackedEditHandle;
  error?: string;
}

export interface TrackedEditRestoreDescriptor {
  /** Stable `${assistantMessageId}:edit-${blockIndex}` identity. */
  stableEditId: string;
  edit: RedlineEdit;
}

type PersistedTrackedEditRevealStatus =
  | "revealed"
  | "not-found"
  | "resolved"
  | "error";

interface PersistedTrackedEditRevealResult {
  stableEditId: string;
  status: PersistedTrackedEditRevealStatus;
  error?: string;
}

type TrackedEditReleaseStatus =
  | "released"
  | "already-released"
  | "already-resolved"
  | "not-found"
  | "error";

interface TrackedEditReleaseResult {
  handle: TrackedEditHandle;
  status: TrackedEditReleaseStatus;
  resolvedAs?: TrackedEditDecision;
  error?: string;
}

// Word's search API matches within a paragraph only and rejects long search
// strings (~255-char limit), so longer or multi-paragraph originals cannot be
// located and must be skipped rather than half-applied.
const MAX_SEARCH_CHARS = 255;

interface PendingTrackedEdit {
  /** Used to revalidate any dynamically recovered revisions before resolving. */
  expectedEdit: RedlineEdit;
  changes: Word.TrackedChange[];
  /**
   * Word requires a child collection to remain tracked with child objects.
   * Resolution still targets the captured child changes individually.
   */
  parentCollections: Word.TrackedChangeCollection[];
  /**
   * Anchors on the edited passage, most reliable first: the range Word
   * returned for the inserted text, then the search range it replaced. Each is
   * tracked so Word keeps it accurate as the document moves around it. They
   * back "view in the document", and resolution falls back to them when Word
   * would not hand over exact revision proxies at apply time. Word invalidates
   * anchors unpredictably, so they are always tried in order.
   */
  ranges: Word.Range[];
  /** Persisted identity/bookmark survive releasing these in-memory proxies. */
  stableEditId?: string;
  bookmarkName?: string;
}

type TerminalTrackedEditState = TrackedEditDecision | "released";

const pendingTrackedEdits = new Map<TrackedEditHandle, PendingTrackedEdit>();
const terminalTrackedEdits = new Map<
  TrackedEditHandle,
  TerminalTrackedEditState
>();
const MAX_TERMINAL_HANDLE_HISTORY = 1_000;
let nextTrackedEditHandle = 0;

// Every document mutation is chained through one module-level queue. This
// spans hook instances and separate streaming applyTrackedEdits calls.
let wordMutationTail: Promise<void> = Promise.resolve();

function serializeWordMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = wordMutationTail.then(operation);
  wordMutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function createTrackedEditHandle(): TrackedEditHandle {
  nextTrackedEditHandle += 1;
  return `mike-edit-${Date.now().toString(36)}-${nextTrackedEditHandle.toString(36)}-${createSecureUuid()}` as TrackedEditHandle;
}

function rememberTerminalState(
  handle: TrackedEditHandle,
  state: TerminalTrackedEditState,
): void {
  terminalTrackedEdits.set(handle, state);
  if (terminalTrackedEdits.size <= MAX_TERMINAL_HANDLE_HISTORY) return;
  const oldest = terminalTrackedEdits.keys().next().value as
    | TrackedEditHandle
    | undefined;
  if (oldest) terminalTrackedEdits.delete(oldest);
}

/**
 * Office reports most host failures as a bare code — "GeneralException" and
 * friends. Those say nothing to a user, so they never reach the UI.
 */
function isOpaqueWordError(message: string): boolean {
  return /^[A-Za-z]+(Exception|Error)$/.test(message.trim());
}

function describeWordFailure(error: unknown, guidance: string): string {
  const message = getErrorMessage(error);
  return isOpaqueWordError(message) ? guidance : `${message} ${guidance}`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "Word operation failed.";
}

/** Word reports paragraph breaks inconsistently (\r, \n, \v) across hosts. */
function normalizeBreaks(value: string): string {
  return value.replace(/[\r\n\v]+/g, "\n");
}

/** True when the edit changes only character formatting, never text. */
function isFormatEdit(edit: RedlineEdit): boolean {
  return !!edit.format && edit.format.length > 0;
}

function trackedChangesMatchEdit(
  changes: readonly Word.TrackedChange[],
  edit: RedlineEdit,
): boolean {
  if (changes.length === 0) return false;
  if (isFormatEdit(edit)) {
    // A formatting pass generates only "Formatted" revisions whose combined
    // text is the passage that was restyled.
    const allFormatted = changes.every(
      (change) => String(change.type).toLowerCase() === "formatted",
    );
    const formattedText = changes.map((change) => change.text).join("");
    return (
      allFormatted &&
      normalizeBreaks(formattedText) === normalizeBreaks(edit.original)
    );
  }
  const addedText = changes
    .filter((change) => String(change.type).toLowerCase() === "added")
    .map((change) => change.text)
    .join("");
  const deletedText = changes
    .filter((change) => String(change.type).toLowerCase() === "deleted")
    .map((change) => change.text)
    .join("");
  const onlyExpectedTypes = changes.every((change) => {
    const type = String(change.type).toLowerCase();
    return type === "added" || type === "deleted";
  });
  return (
    onlyExpectedTypes &&
    normalizeBreaks(addedText) ===
      normalizeBreaks(toWordText(edit.replacement)) &&
    normalizeBreaks(deletedText) === normalizeBreaks(edit.original)
  );
}

/**
 * Select, from a possibly wider revision set, exactly the revisions that
 * reconstruct one logical edit.
 *
 * Word ranges do not scope `getTrackedChanges()` to the touched run: on Word
 * for the web a range inside an edited paragraph reports sibling revisions
 * too. Whole-set equality is still tried first because Word may split one
 * insertion into several revisions, which the by-text selection below
 * deliberately does not attempt. The selection requires an unambiguous single
 * Added/Deleted pair; anything less certain returns null so the caller never
 * resolves someone else's revision.
 */
function pickEditRevisionSubset(
  changes: readonly Word.TrackedChange[],
  edit: RedlineEdit,
): Word.TrackedChange[] | null {
  if (trackedChangesMatchEdit(changes, edit)) return [...changes];

  const matches = matchesForSides(changes, edit);
  const sides = editRevisionSides(edit);
  if (sides.added && matches.added.length !== 1) return null;
  if (sides.deleted && matches.deleted.length !== 1) return null;
  // Formatted revisions may arrive split (one per font property or run), all
  // over the same passage text. Every text-matching formatted revision
  // belongs to this edit — apply requires a unique search match, so no other
  // edit can produce formatted revisions with this exact text.
  if (sides.formatted && matches.formatted.length === 0) return null;

  const subset = [
    ...(sides.added ? matches.added : []),
    ...(sides.deleted ? matches.deleted : []),
    ...(sides.formatted ? matches.formatted : []),
  ];
  return subset.length > 0 ? subset : null;
}

/** Which revision kinds an operation still has to account for. */
interface EditRevisionSides {
  added: boolean;
  deleted: boolean;
  formatted: boolean;
}

function editRevisionSides(edit: RedlineEdit): EditRevisionSides {
  if (isFormatEdit(edit)) {
    return { added: false, deleted: false, formatted: true };
  }
  return {
    added: toWordText(edit.replacement).length > 0,
    deleted: edit.original.length > 0,
    formatted: false,
  };
}

function matchesForSides(
  changes: readonly Word.TrackedChange[],
  edit: RedlineEdit,
): {
  added: Word.TrackedChange[];
  deleted: Word.TrackedChange[];
  formatted: Word.TrackedChange[];
} {
  const wordReplacement = normalizeBreaks(toWordText(edit.replacement));
  const original = normalizeBreaks(edit.original);
  // A heading style restyles the whole paragraph, so its Formatted revision
  // reports the paragraph's text — or, on Word for the web, NO text at all
  // (an empty-string paragraph-format revision). Ranges only report the
  // revisions they intersect, so an empty-text match stays scoped to the
  // passage the caller is looking at. Character formats keep the strict
  // equality match.
  const styleScoped = (edit.format ?? []).some(isParagraphStyleFormat);
  const formattedTextMatches = (text: string): boolean =>
    styleScoped
      ? text.length === 0 || normalizeBreaks(text).includes(original)
      : normalizeBreaks(text) === original;
  return {
    added: changes.filter(
      (change) =>
        String(change.type).toLowerCase() === "added" &&
        normalizeBreaks(change.text) === wordReplacement,
    ),
    deleted: changes.filter(
      (change) =>
        String(change.type).toLowerCase() === "deleted" &&
        normalizeBreaks(change.text) === original,
    ),
    formatted: changes.filter(
      (change) =>
        String(change.type).toLowerCase() === "formatted" &&
        formattedTextMatches(change.text),
    ),
  };
}

function trackedObjectsFor(
  entry: PendingTrackedEdit,
): OfficeExtension.ClientObject[] {
  return [...entry.parentCollections, ...entry.changes, ...entry.ranges];
}

function untrackEntry(entry: PendingTrackedEdit): void {
  for (const change of entry.changes) change.untrack();
  for (const collection of entry.parentCollections) collection.untrack();
  for (const range of entry.ranges) range.untrack();
}

/** Delete document-persistent anchor data without changing the edit outcome. */
async function removePersistentAnchorForEntry(
  entry: PendingTrackedEdit,
): Promise<string | undefined> {
  const errors: string[] = [];
  if (entry.bookmarkName) {
    try {
      await Word.run(async (context) => {
        context.document.deleteBookmark(entry.bookmarkName as string);
        await context.sync();
      });
    } catch (error) {
      errors.push(getErrorMessage(error));
    }
  }
  if (entry.stableEditId) {
    try {
      await removeWordEditAnchor(entry.stableEditId);
    } catch (error) {
      errors.push(getErrorMessage(error));
    }
  }
  return errors.length > 0 ? errors.join(" ") : undefined;
}

/** Signals that Word reports no revisions left inside the edited passage. */
class NoRemainingRevisionsError extends Error {}
class ChangedRevisionSetError extends Error {}

interface AnchorEditScan {
  pendingCount: number;
  addedMatches: number;
  deletedMatches: number;
  formattedMatches: number;
}

/**
 * Read-only census of one anchor's pending revisions against the edit. Each
 * anchor gets its own batch: a stale proxy fails its whole `Word.run`, so
 * sharing one would lose the anchors that are still good.
 */
async function scanAnchorForEdit(
  range: Word.Range,
  edit: RedlineEdit,
): Promise<AnchorEditScan> {
  return Word.run([range], async (context) => {
    const collection = range.getTrackedChanges();
    collection.load("items");
    await context.sync();
    if (collection.items.length === 0) {
      return {
        pendingCount: 0,
        addedMatches: 0,
        deletedMatches: 0,
        formattedMatches: 0,
      };
    }
    for (const change of collection.items) change.load(["type", "text"]);
    await context.sync();
    const matches = matchesForSides(collection.items, edit);
    return {
      pendingCount: collection.items.length,
      addedMatches: matches.added.length,
      deletedMatches: matches.deleted.length,
      formattedMatches: matches.formatted.length,
    };
  });
}

/**
 * Resolve the requested sides of the edit through one anchor, re-verifying by
 * content inside the mutating batch so nothing beyond this edit is touched.
 */
async function resolveEditSidesThroughAnchor(
  range: Word.Range,
  decision: TrackedEditDecision,
  edit: RedlineEdit,
  sides: EditRevisionSides,
): Promise<"resolved" | "changed"> {
  return Word.run([range], async (context) => {
    const collection = range.getTrackedChanges();
    collection.load("items");
    await context.sync();
    for (const change of collection.items) change.load(["type", "text"]);
    await context.sync();
    const matches = matchesForSides(collection.items, edit);
    if (sides.added && matches.added.length !== 1) return "changed" as const;
    if (sides.deleted && matches.deleted.length !== 1) {
      return "changed" as const;
    }
    if (sides.formatted && matches.formatted.length === 0) {
      return "changed" as const;
    }
    const targets = [
      ...(sides.added ? matches.added : []),
      ...(sides.deleted ? matches.deleted : []),
      ...(sides.formatted ? matches.formatted : []),
    ];
    for (const change of targets) {
      if (decision === "accept") change.accept();
      else change.reject();
    }
    await context.sync();
    return "resolved" as const;
  });
}

/**
 * Last-resort resolution against the whole document's pending revisions, in
 * one atomic batch. Word for the web reports revisions unreliably through
 * retained range proxies — an anchor can see only the Added half of a
 * replacement, or nothing at all — while the body-level collection stays
 * accurate. Scope safety comes from the exactly-one-per-side guard: if the
 * document holds more than one pending revision with this edit's text on
 * either side, nothing is touched.
 */
async function resolveEditThroughBody(
  decision: TrackedEditDecision,
  edit: RedlineEdit,
): Promise<"resolved" | "changed" | "empty"> {
  return Word.run(async (context) => {
    const collection = context.document.body.getTrackedChanges();
    collection.load("items");
    await context.sync();
    if (collection.items.length === 0) return "empty" as const;
    for (const change of collection.items) change.load(["type", "text"]);
    await context.sync();
    const matches = matchesForSides(collection.items, edit);
    const sides = editRevisionSides(edit);
    if (sides.added && matches.added.length !== 1) return "changed" as const;
    if (sides.deleted && matches.deleted.length !== 1) {
      return "changed" as const;
    }
    if (sides.formatted && matches.formatted.length === 0) {
      return "changed" as const;
    }
    // Style revisions can carry empty text, which cannot disambiguate two
    // pending paragraph-format revisions at document scope — the body-wide
    // fallback therefore demands a unique match for style edits.
    if (
      sides.formatted &&
      (edit.format ?? []).some(isParagraphStyleFormat) &&
      matches.formatted.length !== 1
    ) {
      return "changed" as const;
    }
    const targets = [
      ...(sides.added ? matches.added : []),
      ...(sides.deleted ? matches.deleted : []),
      ...(sides.formatted ? matches.formatted : []),
    ];
    if (targets.length === 0) return "changed" as const;
    for (const change of targets) {
      if (decision === "accept") change.accept();
      else change.reject();
    }
    await context.sync();
    return "resolved" as const;
  });
}

/** Resolve one retained logical edit without touching any other revisions. */
async function resolveTrackedEditNow(
  handle: TrackedEditHandle,
  decision: TrackedEditDecision,
): Promise<TrackedEditResolutionResult> {
  const entry = pendingTrackedEdits.get(handle);
  if (!entry) {
    const terminal = terminalTrackedEdits.get(handle);
    if (terminal === "released") return { handle, status: "released" };
    if (terminal) {
      return {
        handle,
        status: "already-resolved",
        resolvedAs: terminal,
      };
    }
    return { handle, status: "not-found" };
  }

  try {
    let resolvedViaChildren = false;
    let childBatchFailure: unknown = null;
    if (entry.changes.length > 0) {
      try {
        await Word.run(trackedObjectsFor(entry), async (context) => {
          // Resolve the exact captured children, never acceptAll/rejectAll
          // on a document or dynamically re-evaluated range collection.
          for (const change of entry.changes) {
            if (decision === "accept") change.accept();
            else change.reject();
          }
          await context.sync();
        });
        resolvedViaChildren = true;
      } catch (error) {
        // Later edits in the same passage can invalidate these child proxies
        // between apply and resolve. The passage anchors below re-read the
        // live revisions and verify them by content, so a stale child batch
        // is recoverable rather than terminal.
        childBatchFailure = error;
      }
    }
    if (!resolvedViaChildren) {
      // Resolve through the edited passage: it was revision-free before Mike
      // touched it and every mutation below re-verifies content first, which
      // keeps the scope of this decision to Mike's own edit. Word does not
      // reliably report both halves of a replacement through one anchor — an
      // anchor on the inserted text can see only the Added revision and the
      // replaced search range only the Deleted one — so the plan may resolve
      // each side through a different anchor.
      const sidesNeeded = editRevisionSides(entry.expectedEdit);
      let addedAnchor: Word.Range | null = null;
      let deletedAnchor: Word.Range | null = null;
      let formattedAnchor: Word.Range | null = null;
      let ambiguous = false;
      let sawAnyPending = false;
      let anchorFailure: unknown;

      // Pass 1 (read-only): find an anchor for each required side before
      // mutating anything, so a missing side aborts with the document intact.
      for (const range of entry.ranges) {
        try {
          const scan = await scanAnchorForEdit(range, entry.expectedEdit);
          console.debug(
            `[tracked-edit/resolve] anchor scan ${JSON.stringify(scan)}`,
          );
          if (scan.pendingCount > 0) sawAnyPending = true;
          if (scan.addedMatches > 1 || scan.deletedMatches > 1) {
            ambiguous = true;
            break;
          }
          if (sidesNeeded.added && !addedAnchor && scan.addedMatches === 1) {
            addedAnchor = range;
          }
          if (
            sidesNeeded.deleted &&
            !deletedAnchor &&
            scan.deletedMatches === 1
          ) {
            deletedAnchor = range;
          }
          if (
            sidesNeeded.formatted &&
            !formattedAnchor &&
            scan.formattedMatches >= 1
          ) {
            formattedAnchor = range;
          }
          if (
            (!sidesNeeded.added || addedAnchor) &&
            (!sidesNeeded.deleted || deletedAnchor) &&
            (!sidesNeeded.formatted || formattedAnchor)
          ) {
            break;
          }
        } catch (error) {
          anchorFailure = error;
        }
      }

      const planComplete =
        !ambiguous &&
        (!sidesNeeded.added || !!addedAnchor) &&
        (!sidesNeeded.deleted || !!deletedAnchor) &&
        (!sidesNeeded.formatted || !!formattedAnchor);
      if (!planComplete) {
        if (ambiguous) throw new ChangedRevisionSetError();
        // The anchors could not account for every side (Word for the web
        // routinely hides the Deleted half from them). Fall through to the
        // document-level collection, which reports revisions reliably.
        let bodyOutcome: "resolved" | "changed" | "empty";
        try {
          bodyOutcome = await resolveEditThroughBody(
            decision,
            entry.expectedEdit,
          );
        } catch (error) {
          throw (
            anchorFailure ??
            error ??
            (childBatchFailure ?? new NoRemainingRevisionsError())
          );
        }
        console.debug(`[tracked-edit/resolve] body fallback ${bodyOutcome}`);
        if (bodyOutcome !== "resolved") {
          throw (
            anchorFailure ??
            (bodyOutcome === "changed" || sawAnyPending
              ? new ChangedRevisionSetError()
              : (childBatchFailure ?? new NoRemainingRevisionsError()))
          );
        }
      } else if (sidesNeeded.formatted && formattedAnchor) {
        const outcome = await resolveEditSidesThroughAnchor(
          formattedAnchor,
          decision,
          entry.expectedEdit,
          { added: false, deleted: false, formatted: true },
        );
        if (outcome !== "resolved") throw new ChangedRevisionSetError();
      } else if (addedAnchor && addedAnchor === deletedAnchor) {
        const outcome = await resolveEditSidesThroughAnchor(
          addedAnchor,
          decision,
          entry.expectedEdit,
          { added: true, deleted: true, formatted: false },
        );
        if (outcome !== "resolved") throw new ChangedRevisionSetError();
      } else {
        // Pass 2: act. Each mutating batch re-verifies its side, so the worst
        // interleaving outcome is an honest error, never a broadened edit.
        if (addedAnchor) {
          const outcome = await resolveEditSidesThroughAnchor(
            addedAnchor,
            decision,
            entry.expectedEdit,
            { added: true, deleted: false, formatted: false },
          );
          if (outcome !== "resolved") throw new ChangedRevisionSetError();
        }
        if (deletedAnchor) {
          const outcome = await resolveEditSidesThroughAnchor(
            deletedAnchor,
            decision,
            entry.expectedEdit,
            { added: false, deleted: true, formatted: false },
          );
          if (outcome !== "resolved") throw new ChangedRevisionSetError();
        }
      }
    }
    pendingTrackedEdits.delete(handle);
    rememberTerminalState(handle, decision);

    // Resolution is already durable at this point. Bookmark/settings and
    // proxy cleanup are best effort and must never turn a successful document
    // decision into an error.
    const cleanupErrors: string[] = [];
    const persistentCleanupError = await removePersistentAnchorForEntry(entry);
    if (persistentCleanupError) cleanupErrors.push(persistentCleanupError);
    try {
      await Word.run(trackedObjectsFor(entry), async (context) => {
        untrackEntry(entry);
        await context.sync();
      });
    } catch (error) {
      cleanupErrors.push(getErrorMessage(error));
    }
    return {
      handle,
      status: decision === "accept" ? "accepted" : "rejected",
      resolvedAs: decision,
      ...(cleanupErrors.length > 0
        ? {
            error: `The edit was resolved, but anchor cleanup failed: ${cleanupErrors.join(" ")}`,
          }
        : {}),
    };
  } catch (error) {
    // Office batches can fail after executing earlier queued commands. Never
    // retry stale proxies, but rebuild a fresh handle from the durable bookmark
    // when Word still reports the exact expected revision set.
    pendingTrackedEdits.delete(handle);
    try {
      await Word.run(trackedObjectsFor(entry), async (context) => {
        untrackEntry(entry);
        await context.sync();
      });
    } catch {
      // Best-effort cleanup only; retain the original resolution error.
    }
    if (error instanceof NoRemainingRevisionsError) {
      rememberTerminalState(handle, "released");
      return {
        handle,
        status: "not-found",
        error:
          "Word no longer reports a revision for this change. Review it from Word’s Review tab.",
      };
    }
    if (error instanceof ChangedRevisionSetError) {
      rememberTerminalState(handle, "released");
      return {
        handle,
        status: "error",
        error:
          "The revisions in this passage changed after Mike applied the edit. Review them directly in Word.",
      };
    }
    if (entry.stableEditId && entry.bookmarkName) {
      const restored = await restoreTrackedEditNow(
        entry.stableEditId,
        entry.expectedEdit,
      );
      rememberTerminalState(handle, "released");
      if (restored.status === "restored" && restored.handle) {
        return {
          handle: restored.handle,
          status: "error",
          error: describeWordFailure(
            error,
            "Word refreshed this change. Please try the action again.",
          ),
        };
      }
    } else {
      rememberTerminalState(handle, "released");
    }
    return {
      handle,
      status: "error",
      error: describeWordFailure(
        error,
        "Word couldn’t update this change. Review it directly in Word before retrying.",
      ),
    };
  }
}

/**
 * Scroll Word to the passage this edit changed and select it, so "View" lands
 * the user on the revision rather than describing where to find it.
 */
export function revealTrackedEdit(
  handle: TrackedEditHandle,
): Promise<TrackedEditRevealResult> {
  return serializeWordMutation(async () => {
    const entry = pendingTrackedEdits.get(handle);
    if (!entry) {
      const terminal = terminalTrackedEdits.get(handle);
      if (terminal === "released")
        return { handle, status: "released" as const };
      if (terminal) {
        return {
          handle,
          status: "already-resolved" as const,
          resolvedAs: terminal,
        };
      }
      return { handle, status: "not-found" as const };
    }

    // Selecting scrolls the document to the passage; a retained anchor has
    // followed it through any edits made since. Word invalidates anchors
    // unpredictably and fails the whole batch when it does, so each one is
    // tried on its own until the document actually moves.
    for (const range of entry.ranges) {
      try {
        await Word.run([range], async (context) => {
          range.select();
          await context.sync();
        });
        return { handle, status: "revealed" as const };
      } catch {
        // Anchor is stale; fall through to the next one.
      }
    }

    return {
      handle,
      status: "error" as const,
      error:
        "Word couldn’t scroll to this change. Find it in Word’s Review tab.",
    };
  });
}

/**
 * Rebuild an exact in-memory review handle from a document-persistent hidden
 * bookmark. The text/type verification prevents a later user revision inside
 * the bookmarked passage from being accepted or rejected by Mike.
 */
async function restoreTrackedEditNow(
  stableEditId: string,
  edit: RedlineEdit,
): Promise<TrackedEditRestoreResult> {
  for (const [handle, entry] of pendingTrackedEdits) {
    if (entry.stableEditId === stableEditId) {
      return { stableEditId, status: "restored" as const, handle };
    }
  }

  let bookmarkName = bookmarkNameForEdit(stableEditId);
  let anchorWasRegistered = false;
  try {
    const anchor = getWordEditAnchor(stableEditId);
    if (anchor) {
      bookmarkName = anchor.bookmarkName;
      anchorWasRegistered = true;
    }
  } catch {
    // The deterministic bookmark name still permits recovery if settings
    // were unavailable or failed to save.
  }

  try {
    const restored = await Word.run(async (context) => {
      const range = context.document.getBookmarkRangeOrNullObject(bookmarkName);
      range.load("isNullObject");
      await context.sync();
      if (range.isNullObject) return { status: "not-found" as const };

      const collection = range.getTrackedChanges();
      collection.load("items");
      await context.sync();
      if (collection.items.length === 0) {
        context.document.deleteBookmark(bookmarkName);
        await context.sync();
        return { status: "resolved" as const };
      }

      for (const change of collection.items) change.load(["type", "text"]);
      await context.sync();
      // The bookmark range can report sibling revisions from the same
      // paragraph — or, on Word for the web, only one half of the
      // replacement pair. Manage the unambiguous subset that reconstructs
      // this edit, consulting the reliable document-level collection when
      // the bookmark's own report cannot account for both sides.
      let editRevisions = pickEditRevisionSubset(collection.items, edit);
      let managedCollection = collection;
      if (!editRevisions) {
        const bodyCollection = context.document.body.getTrackedChanges();
        bodyCollection.load("items");
        await context.sync();
        for (const change of bodyCollection.items) {
          change.load(["type", "text"]);
        }
        await context.sync();
        editRevisions = pickEditRevisionSubset(bodyCollection.items, edit);
        managedCollection = bodyCollection;
      }
      if (!editRevisions) {
        return { status: "view-only" as const };
      }

      managedCollection.track();
      for (const change of editRevisions) change.track();
      range.track();
      await context.sync();
      return {
        status: "restored" as const,
        collection: managedCollection,
        changes: editRevisions,
        range,
      };
    });

    if (restored.status === "not-found" || restored.status === "resolved") {
      try {
        await removeWordEditAnchor(stableEditId);
      } catch {
        // The stale mapping is harmless and will be pruned on a later load.
      }
      return { stableEditId, status: restored.status };
    }
    if (!anchorWasRegistered) {
      await persistWordEditAnchor(stableEditId, bookmarkName).catch((error) => {
        console.error(
          "[tracked-edit/restore] Failed to repair the document anchor registry.",
          { stableEditId, bookmarkName, error },
        );
      });
    }
    if (restored.status === "view-only") {
      return { stableEditId, status: "view-only" };
    }

    const handle = createTrackedEditHandle();
    pendingTrackedEdits.set(handle, {
      expectedEdit: edit,
      changes: restored.changes,
      parentCollections: [restored.collection],
      ranges: [restored.range],
      stableEditId,
      bookmarkName,
    });
    return { stableEditId, status: "restored", handle };
  } catch (error) {
    return {
      stableEditId,
      status: "error",
      error: describeWordFailure(
        error,
        "Word couldn’t restore this tracked change. Review it from Word’s Review tab.",
      ),
    };
  }
}

/**
 * Batched counterpart of `restoreTrackedEditNow` for chat open, which restores
 * every stored edit at once. Each `Word.run` costs several host round-trips,
 * and the global mutation queue serializes them, so restoring per edit makes
 * the pane's readiness linear in chat history. One shared batch loads ALL
 * bookmark lookups before each sync, keeping the whole restore at a constant
 * number of syncs. A missing bookmark is a null object, never a batch failure;
 * if Word fails the shared batch outright (one stale object fails its whole
 * `Word.run`), each edit is retried individually so it gets its own verdict.
 */
async function restoreTrackedEditsNow(
  descriptors: readonly TrackedEditRestoreDescriptor[],
): Promise<TrackedEditRestoreResult[]> {
  const results = new Map<number, TrackedEditRestoreResult>();

  interface RestoreCandidate {
    index: number;
    stableEditId: string;
    edit: RedlineEdit;
    bookmarkName: string;
    anchorWasRegistered: boolean;
  }
  const candidates: RestoreCandidate[] = [];

  descriptors.forEach(({ stableEditId, edit }, index) => {
    for (const [handle, entry] of pendingTrackedEdits) {
      if (entry.stableEditId === stableEditId) {
        results.set(index, { stableEditId, status: "restored", handle });
        return;
      }
    }

    let bookmarkName = bookmarkNameForEdit(stableEditId);
    let anchorWasRegistered = false;
    try {
      const anchor = getWordEditAnchor(stableEditId);
      if (anchor) {
        bookmarkName = anchor.bookmarkName;
        anchorWasRegistered = true;
      }
    } catch {
      // The deterministic bookmark name still permits recovery if settings
      // were unavailable or failed to save.
    }
    candidates.push({
      index,
      stableEditId,
      edit,
      bookmarkName,
      anchorWasRegistered,
    });
  });

  if (candidates.length > 0) {
    type BatchOutcome =
      | { status: "not-found" }
      | { status: "resolved" }
      | { status: "view-only" }
      | {
          status: "restored";
          collection: Word.TrackedChangeCollection;
          changes: Word.TrackedChange[];
          range: Word.Range;
        };
    try {
      const outcomes = await Word.run(async (context) => {
        const byCandidate = new Map<RestoreCandidate, BatchOutcome>();

        const lookups = candidates.map((candidate) => {
          const range = context.document.getBookmarkRangeOrNullObject(
            candidate.bookmarkName,
          );
          range.load("isNullObject");
          return { candidate, range };
        });
        await context.sync();

        const present: {
          candidate: RestoreCandidate;
          range: Word.Range;
          collection: Word.TrackedChangeCollection;
        }[] = [];
        for (const { candidate, range } of lookups) {
          if (range.isNullObject) {
            byCandidate.set(candidate, { status: "not-found" });
            continue;
          }
          const collection = range.getTrackedChanges();
          collection.load("items");
          present.push({ candidate, range, collection });
        }
        if (present.length > 0) await context.sync();

        const withRevisions: typeof present = [];
        let staleBookmarkQueued = false;
        for (const entry of present) {
          if (entry.collection.items.length === 0) {
            context.document.deleteBookmark(entry.candidate.bookmarkName);
            staleBookmarkQueued = true;
            byCandidate.set(entry.candidate, { status: "resolved" });
            continue;
          }
          for (const change of entry.collection.items) {
            change.load(["type", "text"]);
          }
          withRevisions.push(entry);
        }
        if (staleBookmarkQueued || withRevisions.length > 0) {
          await context.sync();
        }

        let trackingQueued = false;
        const bodyFallback: typeof present = [];
        for (const entry of withRevisions) {
          // Manage only the unambiguous subset that reconstructs this edit:
          // the bookmark range can report sibling revisions from the same
          // paragraph, or (on Word for the web) only one half of the pair.
          const subset = pickEditRevisionSubset(
            entry.collection.items,
            entry.candidate.edit,
          );
          if (!subset) {
            bodyFallback.push(entry);
            continue;
          }
          entry.collection.track();
          for (const change of subset) change.track();
          entry.range.track();
          trackingQueued = true;
          byCandidate.set(entry.candidate, {
            status: "restored",
            collection: entry.collection,
            changes: subset,
            range: entry.range,
          });
        }
        if (bodyFallback.length > 0) {
          // One shared document-level read verifies the candidates whose
          // bookmark could not account for both halves of their replacement.
          // The consumed set stops two edits from ever binding the same
          // revision proxy.
          const bodyCollection = context.document.body.getTrackedChanges();
          bodyCollection.load("items");
          await context.sync();
          for (const change of bodyCollection.items) {
            change.load(["type", "text"]);
          }
          await context.sync();
          const consumed = new Set<Word.TrackedChange>();
          let bodyCollectionTracked = false;
          for (const entry of bodyFallback) {
            const subset = pickEditRevisionSubset(
              bodyCollection.items,
              entry.candidate.edit,
            );
            if (!subset || subset.some((change) => consumed.has(change))) {
              byCandidate.set(entry.candidate, { status: "view-only" });
              continue;
            }
            for (const change of subset) consumed.add(change);
            if (!bodyCollectionTracked) {
              bodyCollection.track();
              bodyCollectionTracked = true;
            }
            for (const change of subset) change.track();
            entry.range.track();
            trackingQueued = true;
            byCandidate.set(entry.candidate, {
              status: "restored",
              collection: bodyCollection,
              changes: subset,
              range: entry.range,
            });
          }
        }
        if (trackingQueued) await context.sync();

        return byCandidate;
      });

      for (const candidate of candidates) {
        const outcome = outcomes.get(candidate);
        // Every candidate is classified inside the batch; treat a gap as a
        // per-edit failure rather than crashing the other restorations.
        if (!outcome) continue;
        if (outcome.status === "not-found" || outcome.status === "resolved") {
          try {
            await removeWordEditAnchor(candidate.stableEditId);
          } catch {
            // The stale mapping is harmless and will be pruned on a later load.
          }
          results.set(candidate.index, {
            stableEditId: candidate.stableEditId,
            status: outcome.status,
          });
          continue;
        }
        if (!candidate.anchorWasRegistered) {
          await persistWordEditAnchor(
            candidate.stableEditId,
            candidate.bookmarkName,
          ).catch((error) => {
            console.error(
              "[tracked-edit/restore] Failed to repair the document anchor registry.",
              {
                stableEditId: candidate.stableEditId,
                bookmarkName: candidate.bookmarkName,
                error,
              },
            );
          });
        }
        if (outcome.status === "view-only") {
          results.set(candidate.index, {
            stableEditId: candidate.stableEditId,
            status: "view-only",
          });
          continue;
        }

        const handle = createTrackedEditHandle();
        pendingTrackedEdits.set(handle, {
          expectedEdit: candidate.edit,
          changes: outcome.changes,
          parentCollections: [outcome.collection],
          ranges: [outcome.range],
          stableEditId: candidate.stableEditId,
          bookmarkName: candidate.bookmarkName,
        });
        results.set(candidate.index, {
          stableEditId: candidate.stableEditId,
          status: "restored",
          handle,
        });
      }
    } catch {
      // The shared batch failed as a whole. Fall back to one edit at a time
      // so a single bad object cannot take every other restoration with it.
      for (const candidate of candidates) {
        results.set(
          candidate.index,
          await restoreTrackedEditNow(candidate.stableEditId, candidate.edit),
        );
      }
    }
  }

  return descriptors.map(
    ({ stableEditId }, index) =>
      results.get(index) ?? {
        stableEditId,
        status: "error" as const,
        error:
          "Word couldn’t restore this tracked change. Review it from Word’s Review tab.",
      },
  );
}

export function restoreTrackedEdits(
  descriptors: readonly TrackedEditRestoreDescriptor[],
): Promise<TrackedEditRestoreResult[]> {
  return serializeWordMutation(() => restoreTrackedEditsNow(descriptors));
}

/** Navigate through a persistent bookmark when exact review controls are unsafe. */
export function revealPersistedTrackedEdit(
  stableEditId: string,
): Promise<PersistedTrackedEditRevealResult> {
  return serializeWordMutation(async () => {
    let bookmarkName = bookmarkNameForEdit(stableEditId);
    try {
      bookmarkName =
        getWordEditAnchor(stableEditId)?.bookmarkName ?? bookmarkName;
    } catch {
      // Fall back to the name deterministically derived from the stable ID.
    }

    try {
      const status = await Word.run(async (context) => {
        const range =
          context.document.getBookmarkRangeOrNullObject(bookmarkName);
        range.load("isNullObject");
        await context.sync();
        if (range.isNullObject) {
          return "not-found" as const;
        }

        const changes = range.getTrackedChanges();
        changes.load("items");
        await context.sync();
        if (changes.items.length === 0) {
          context.document.deleteBookmark(bookmarkName);
          await context.sync();
          return "resolved" as const;
        }

        range.select();
        await context.sync();
        return "revealed" as const;
      });

      if (status === "not-found" || status === "resolved") {
        try {
          await removeWordEditAnchor(stableEditId);
        } catch {
          // Best-effort stale metadata cleanup.
        }
      }
      return { stableEditId, status };
    } catch (error) {
      console.error(
        "[tracked-edit/view] Word failed while revealing the persistent bookmark.",
        { stableEditId, bookmarkName, error },
      );
      return {
        stableEditId,
        status: "error",
        error: describeWordFailure(
          error,
          "Word couldn’t scroll to this tracked change.",
        ),
      };
    }
  });
}

export type DocumentTextRevealStatus = "selected" | "not-found" | "error";

/**
 * Scroll Word to a cited passage: search the body for the exact quote and
 * select the first occurrence (selection is Word's scroll-and-highlight).
 * Falls back to a case-insensitive search before giving up, since citations
 * are model-copied text and the document may have changed since.
 */
export function selectDocumentText(
  text: string,
): Promise<DocumentTextRevealStatus> {
  return serializeWordMutation(async () => {
    const target = text.trim();
    if (
      !target ||
      target.includes("\n") ||
      target.includes("\r") ||
      target.includes("^") ||
      target.length > MAX_SEARCH_CHARS
    ) {
      return "not-found" as const;
    }
    try {
      return await Word.run(async (context) => {
        let matches = context.document.body.search(target, {
          matchCase: true,
        });
        matches.load("items");
        await context.sync();
        if (matches.items.length === 0) {
          matches = context.document.body.search(target, {
            matchCase: false,
          });
          matches.load("items");
          await context.sync();
        }
        const first = matches.items[0];
        if (!first) return "not-found" as const;
        first.select();
        await context.sync();
        return "selected" as const;
      });
    } catch (error) {
      console.debug(
        "[citation] Word couldn’t select the cited text.",
        getErrorMessage(error),
      );
      return "error" as const;
    }
  });
}

export function resolveTrackedEdit(
  handle: TrackedEditHandle,
  decision: TrackedEditDecision,
): Promise<TrackedEditResolutionResult> {
  return serializeWordMutation(() => resolveTrackedEditNow(handle, decision));
}

export function resolveTrackedEdits(
  handles: readonly TrackedEditHandle[],
  decision: TrackedEditDecision,
): Promise<TrackedEditResolutionResult[]> {
  return serializeWordMutation(async () => {
    const results: TrackedEditResolutionResult[] = [];
    for (const handle of handles) {
      results.push(await resolveTrackedEditNow(handle, decision));
    }
    return results;
  });
}

/**
 * Stop retaining unresolved Word proxies, for example when a chat unmounts.
 * This does not accept or reject any document revision.
 */
export function releaseTrackedEdits(
  handles: readonly TrackedEditHandle[],
): Promise<TrackedEditReleaseResult[]> {
  return serializeWordMutation(async () => {
    const results: TrackedEditReleaseResult[] = [];

    for (const handle of handles) {
      const entry = pendingTrackedEdits.get(handle);
      if (!entry) {
        const terminal = terminalTrackedEdits.get(handle);
        if (terminal === "released") {
          results.push({ handle, status: "already-released" });
        } else if (terminal) {
          results.push({
            handle,
            status: "already-resolved",
            resolvedAs: terminal,
          });
        } else {
          results.push({ handle, status: "not-found" });
        }
        continue;
      }

      try {
        await Word.run(trackedObjectsFor(entry), async (context) => {
          untrackEntry(entry);
          await context.sync();
        });
        pendingTrackedEdits.delete(handle);
        rememberTerminalState(handle, "released");
        results.push({ handle, status: "released" });
      } catch (error) {
        // A proxy that failed to untrack is not safe to hand back to a later
        // tracked-edit controller. Evict it so a reload reconstructs fresh
        // proxies from the document bookmark instead of shadowing that valid
        // anchor.
        pendingTrackedEdits.delete(handle);
        rememberTerminalState(handle, "released");
        results.push({
          handle,
          status: "error",
          error: getErrorMessage(error),
        });
      }
    }

    return results;
  });
}

/**
 * Hook exposing document read/write helpers that wrap the Word JS API.
 * All functions return Promises and must be called in a component context
 * where Office.js has already initialised (i.e. inside Office.onReady).
 */
export function useWordDoc() {
  /** Read the plain text of the entire document body. */
  const readDocumentText = useCallback(
    (): Promise<string> =>
      serializeWordMutation(() =>
        Word.run(async (context) => {
          const body = context.document.body;
          body.load("text");
          await context.sync();
          return body.text;
        }),
      ),
    [],
  );

  /**
   * Apply model-proposed edits to existing document text as tracked changes.
   *
   * Each edit's `original` is located with Word's search API (case-sensitive)
   * and applied only when it identifies one exact range. The replacement runs
   * while `changeTrackingMode` is TrackAll, so
   * the result is a genuine redline — deletion struck through, insertion
   * marked — that the user can accept or reject per change in Word's Review
   * tab. Edits whose text can no longer be found (the user edited the
   * document, or the model mis-copied) are reported, never guessed at.
   */
  const applyTrackedEdits = useCallback(
    (edits: PersistedRedlineEdit[]): Promise<RedlineApplyReport> =>
      serializeWordMutation(() =>
        Word.run(async (context) => {
          const doc = context.document;
          doc.load("changeTrackingMode");
          await context.sync();

          const originalMode = doc.changeTrackingMode;
          const report: RedlineApplyReport = {
            edits: [],
          };
          const stagedHandles: {
            handle: TrackedEditHandle;
            entry: PendingTrackedEdit;
          }[] = [];
          const stagedAnchors: {
            stableEditId: string;
            bookmarkName: string;
            result: TrackedEditApplyResult;
          }[] = [];

          try {
            // Sync this separately so every later insert is guaranteed to be
            // authored under TrackAll, irrespective of the user's prior mode.
            doc.changeTrackingMode = Word.ChangeTrackingMode.trackAll;
            await context.sync();

            for (const [index, edit] of edits.entries()) {
              const original = edit.original;
              const result: TrackedEditApplyResult = {
                index,
                original,
                replacement: edit.replacement,
                status: "error",
                matches: 0,
                appliedMatches: 0,
              };
              let mutationApplied = false;
              let trackingQueued = false;
              let candidateCollections: Word.TrackedChangeCollection[] = [];
              let candidateChanges: Word.TrackedChange[] = [];
              let candidateRanges: Word.Range[] = [];

              if (
                !original ||
                original.includes("\n") ||
                original.includes("\r") ||
                original.includes("^") ||
                original.length > MAX_SEARCH_CHARS
              ) {
                result.status = "skipped";
                result.reason = "unsearchable";
                report.edits.push(result);
                continue;
              }

              try {
                const matches = doc.body.search(original, { matchCase: true });
                matches.load("items");
                await context.sync();

                result.matches = matches.items.length;

                if (matches.items.length === 0) {
                  result.status = "not-found";
                  report.edits.push(result);
                  continue;
                }

                // A model block describes one concrete source passage. Applying
                // it to every identical clause would silently broaden the edit,
                // so require an unambiguous exact location.
                if (matches.items.length > 1) {
                  result.status = "skipped";
                  result.reason = "ambiguous";
                  result.error = `Found ${matches.items.length} exact matches; no edit was applied.`;
                  report.edits.push(result);
                  continue;
                }

                // Never mix Mike's lifecycle with revisions that were already
                // present in the exact target. Skipping the whole logical edit
                // also avoids partially applying a repeated occurrence.
                const existingCollections = matches.items.map((match) => {
                  const collection = match.getTrackedChanges();
                  collection.load("items");
                  return collection;
                });
                await context.sync();

                if (
                  existingCollections.some(
                    (collection) => collection.items.length > 0,
                  )
                ) {
                  result.status = "skipped";
                  result.reason = "pre-existing-revisions";
                  report.edits.push(result);
                  continue;
                }

                // Because every target range was revision-free immediately
                // above, the changes obtained from those same ranges after the
                // queued replacements are exactly the changes this edit made.
                const formatOnly = isFormatEdit(edit);
                const wordReplacement = formatOnly
                  ? ""
                  : toWordText(edit.replacement);
                const insertedRanges: Word.Range[] = [];
                const generatedCollections = matches.items.map((match) => {
                  if (formatOnly) {
                    // Restyling under TrackAll produces a "Formatted"
                    // revision over the same text; the search range stays
                    // valid because nothing was replaced. Heading styles are
                    // paragraph-scoped by Word's own model, so they restyle
                    // the paragraph containing the passage (the prompt
                    // instructs the model to only target heading-worthy
                    // paragraphs).
                    for (const format of edit.format ?? []) {
                      if (format === "bold") match.font.bold = true;
                      else if (format === "italic") match.font.italic = true;
                      else if (format === "underline") {
                        match.font.underline = Word.UnderlineType.single;
                      } else if (isParagraphStyleFormat(format)) {
                        const styleByFormat = {
                          heading1: Word.BuiltInStyleName.heading1,
                          heading2: Word.BuiltInStyleName.heading2,
                          heading3: Word.BuiltInStyleName.heading3,
                        } as const;
                        const style =
                          styleByFormat[
                            format as keyof typeof styleByFormat
                          ];
                        if (style) {
                          match.paragraphs.getFirst().styleBuiltIn = style;
                        }
                      }
                    }
                  } else {
                    // The range Word returns for the inserted text is the
                    // sturdier anchor: replacing a search range can leave
                    // that original proxy stale, which Word then reports as
                    // a bare exception.
                    const inserted = match.insertText(
                      wordReplacement,
                      Word.InsertLocation.replace,
                    );
                    if (inserted) insertedRanges.push(inserted);
                  }
                  const collection = match.getTrackedChanges();
                  collection.load("items");
                  return collection;
                });
                await context.sync();
                mutationApplied = true;

                result.appliedMatches = matches.items.length;

                const generatedChanges = generatedCollections.flatMap(
                  (collection) => collection.items,
                );

                // Prefer managing the exact revisions this edit generated. A
                // range does not scope getTrackedChanges() to the touched
                // run — in a shared paragraph Word reports sibling revisions
                // too — so the verified set may be a by-text subset of what
                // Word handed over. Anything less certain than an unambiguous
                // subset is still Mike's edit (the target was revision-free a
                // moment ago), so it stays reviewable through the edited
                // passage instead of being handed back.
                let managedCollections = generatedCollections;
                let managedChanges = generatedChanges;
                let exactRevisions =
                  generatedChanges.length > 0 &&
                  generatedCollections.every(
                    (collection) => collection.items.length > 0,
                  );

                // The replaced search range and the inserted-text range both
                // end up spanning only the NEW text, so on Word for the web
                // their collections report just the Added revision — the
                // Deleted run sits beside them. The edited paragraph contains
                // both halves; its collection is the recovery source and the
                // last-resort resolution anchor. (Original text never spans
                // paragraphs, so the Deleted run is always in this first
                // paragraph.)
                let paragraphRange: Word.Range | null = null;
                try {
                  const paragraphSource =
                    insertedRanges[0] ?? matches.items[0];
                  paragraphRange = paragraphSource
                    ? paragraphSource.paragraphs.getFirst().getRange("Whole")
                    : null;
                } catch {
                  paragraphRange = null;
                }

                if (exactRevisions) {
                  for (const change of generatedChanges) {
                    change.load(["type", "text"]);
                  }
                  await context.sync();

                  const verifiedSubset = pickEditRevisionSubset(
                    generatedChanges,
                    edit,
                  );
                  if (verifiedSubset) {
                    managedChanges = verifiedSubset;
                  } else {
                    exactRevisions = false;
                    result.reason = "unexpected-revisions";
                  }
                }

                if (!exactRevisions) {
                  // Re-read the passage once before giving up on exact review
                  // controls: the paragraph supplies revisions the tight
                  // ranges cannot see, and Word for the web may materialize
                  // generated revisions only after the batch that queued the
                  // replacement.
                  const rereadTargets = [
                    ...(paragraphRange ? [paragraphRange] : []),
                    ...(insertedRanges.length > 0
                      ? insertedRanges
                      : matches.items),
                  ];
                  const rereadCollections = rereadTargets.map((range) => {
                    const collection = range.getTrackedChanges();
                    collection.load("items");
                    return collection;
                  });
                  await context.sync();
                  const rereadChanges = rereadCollections.flatMap(
                    (collection) => collection.items,
                  );
                  for (const change of rereadChanges) {
                    change.load(["type", "text"]);
                  }
                  await context.sync();

                  // Evaluate each collection on its own: the same underlying
                  // revision reaches this batch as a distinct proxy per
                  // range, so a union would double-count it and trip the
                  // exactly-one ambiguity guard.
                  let recovered: {
                    collection: Word.TrackedChangeCollection;
                    subset: Word.TrackedChange[];
                  } | null = null;
                  for (const collection of rereadCollections) {
                    if (recovered) break;
                    const subset =
                      collection.items.length > 0
                        ? pickEditRevisionSubset(collection.items, edit)
                        : null;
                    if (subset) recovered = { collection, subset };
                  }
                  console.debug(
                    `[tracked-edit/apply] revision re-read ${JSON.stringify({
                      rereadCount: rereadChanges.length,
                      recovered: !!recovered,
                    })}`,
                  );
                  if (recovered) {
                    managedCollections = [recovered.collection];
                    managedChanges = recovered.subset;
                    exactRevisions = true;
                    result.reason = undefined;
                  } else if (!result.reason) {
                    result.reason = "no-tracked-changes";
                  }
                }
                candidateCollections = managedCollections;
                candidateChanges = managedChanges;

                // Track each retained proxy so it stays valid after this
                // Word.run completes: the exact children when they were
                // verified, and always the edited passage itself.
                trackingQueued = true;
                if (exactRevisions) {
                  for (const collection of managedCollections) {
                    collection.track();
                  }
                  for (const change of managedChanges) change.track();
                }
                const revisionRanges = exactRevisions
                  ? managedChanges
                      .map((change) => ({
                        range: change.getRange("Whole"),
                        type: String(change.type).toLowerCase(),
                      }))
                      .sort((left, right) => {
                        if (left.type === right.type) return 0;
                        return left.type === "added" ? -1 : 1;
                      })
                      .map(({ range }) => range)
                  : [];
                candidateRanges = [
                  ...revisionRanges,
                  ...insertedRanges,
                  ...matches.items,
                  ...(paragraphRange ? [paragraphRange] : []),
                ];
                for (const range of candidateRanges) range.track();
                await context.sync();

                let bookmarkName: string | undefined;
                if (edit.stableEditId && candidateRanges.length > 0) {
                  // Without per-revision ranges, fall back to the paragraph:
                  // the tight ranges span only the inserted text, and a
                  // bookmark that misses the Deleted half restores view-only.
                  const persistentRanges =
                    revisionRanges.length > 0
                      ? revisionRanges
                      : paragraphRange
                        ? [paragraphRange]
                        : [...insertedRanges, ...matches.items];
                  const [firstPersistentRange, ...remainingPersistentRanges] =
                    persistentRanges;
                  if (firstPersistentRange) {
                    const candidateBookmarkName = bookmarkNameForEdit(
                      edit.stableEditId,
                    );
                    try {
                      let bookmarkRange = firstPersistentRange;
                      for (const range of remainingPersistentRanges) {
                        bookmarkRange = bookmarkRange.expandTo(range);
                      }
                      bookmarkRange.insertBookmark(candidateBookmarkName);
                      await context.sync();
                      bookmarkName = candidateBookmarkName;
                      result.persistentAnchor = true;
                      stagedAnchors.push({
                        stableEditId: edit.stableEditId,
                        bookmarkName,
                        result,
                      });
                    } catch (error) {
                      result.error = describeWordFailure(
                        error,
                        "The change is reviewable now, but its View link may not survive reopening the add-in.",
                      );
                    }
                  }
                }

                const handle = createTrackedEditHandle();
                stagedHandles.push({
                  handle,
                  entry: {
                    expectedEdit: edit,
                    changes: exactRevisions ? managedChanges : [],
                    parentCollections: exactRevisions
                      ? managedCollections
                      : [],
                    ranges: candidateRanges,
                    ...(bookmarkName && edit.stableEditId
                      ? {
                          stableEditId: edit.stableEditId,
                          bookmarkName,
                        }
                      : {}),
                  },
                });
                result.status = "applied";
                result.handle = handle;
                report.edits.push(result);
              } catch (error) {
                if (trackingQueued) {
                  try {
                    for (const change of candidateChanges) change.untrack();
                    for (const collection of candidateCollections) {
                      collection.untrack();
                    }
                    for (const range of candidateRanges) range.untrack();
                    await context.sync();
                  } catch {
                    // The edit remains a valid Word revision even if proxy
                    // cleanup is unavailable; the UI hands review back to Word.
                  }
                }
                result.status = mutationApplied ? "applied-unmanaged" : "error";
                result.reason = "word-error";
                result.error = mutationApplied
                  ? "Applied in Word, but Mike couldn’t retain its review controls. Review it from Word’s Review tab."
                  : describeWordFailure(
                      error,
                      "Word couldn’t apply this change.",
                    );
                report.edits.push(result);
              }
            }
          } finally {
            try {
              doc.changeTrackingMode = originalMode;
              await context.sync();
            } catch (error) {
              report.warning = describeWordFailure(
                error,
                "Word couldn’t restore the previous change-tracking mode.",
              );
            }
          }

          // Publish handle ownership only after change-tracking restoration has
          // completed (or its warning has been recorded), so callers can always
          // release every retained proxy returned by this operation.
          for (const staged of stagedHandles) {
            pendingTrackedEdits.set(staged.handle, staged.entry);
          }
          for (const anchor of stagedAnchors) {
            try {
              await persistWordEditAnchor(
                anchor.stableEditId,
                anchor.bookmarkName,
              );
            } catch (error) {
              anchor.result.error = describeWordFailure(
                error,
                "The change is reviewable now, but its View link may not survive reopening the document.",
              );
            }
          }
          return report;
        }),
      ),
    [],
  );

  return {
    readDocumentText,
    applyTrackedEdits,
  };
}
