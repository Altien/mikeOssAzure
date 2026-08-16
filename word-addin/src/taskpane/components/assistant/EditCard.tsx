import React from "react";
import { EditCardUI } from "@mike/edit-card-ui";
import type { RedlineEdit } from "../../lib/redline";
import { EDIT_CARD_SURFACE } from "./message/messageStyles";
import type { EditCardStatus } from "../../lib/wordChatTypes";

interface EditCardProps {
  /** Fields can arrive independently while a streamed edit is being parsed. */
  edit: Partial<RedlineEdit>;
  changeNumber?: number;
  status?: EditCardStatus;
  /** Scrolls Word to the revision this card applied. */
  onView?: () => void;
  onAccept?: () => void;
  onReject?: () => void;
  /** What Word reported, shown in place of the generic status copy. */
  error?: string;
  /** Disables both resolution actions while a Word operation is in flight. */
  disabled?: boolean;
}

const STATUS_COPY: Record<
  Exclude<EditCardStatus, "pending">,
  { copy: string; className: string }
> = {
  receiving: { copy: "Receiving change…", className: "text-gray-400" },
  applying: { copy: "Applying to the document…", className: "text-gray-500" },
  restoring: { copy: "Checking the document…", className: "text-gray-400" },
  "view-only": {
    copy: "Tracked change found — review it in Word.",
    className: "text-gray-500",
  },
  applied: { copy: "Applied to the document.", className: "text-green-700" },
  accepted: { copy: "Accepted.", className: "text-green-700" },
  rejected: { copy: "Rejected.", className: "text-gray-500" },
  skipped: {
    copy: "Skipped — source text was not found.",
    className: "text-gray-500",
  },
  ambiguous: {
    copy: "Skipped — source text appears more than once.",
    className: "text-gray-500",
  },
  incomplete: {
    copy: "Incomplete change — not applied.",
    className: "text-gray-500",
  },
  unmanaged: {
    copy: "Applied in Word — review it from Word’s Review tab.",
    className: "text-amber-700",
  },
  error: { copy: "Couldn’t apply this change.", className: "text-red-500" },
  historical: { copy: "Historical change.", className: "text-gray-400" },
};

/**
 * A single proposed tracked change, rendered with the web app's EditCard
 * look: reason line, then the replacement in green and the original in red
 * strikethrough on a serif gray slab. Its lifecycle is controlled by the
 * caller so Word mutations stay outside this presentational component.
 */
export function EditCard({
  edit,
  changeNumber,
  status = "pending",
  onView,
  onAccept,
  onReject,
  error,
  disabled = false,
}: EditCardProps): React.ReactElement {
  const statusCopy = status === "pending" ? undefined : STATUS_COPY[status];
  // Every other status already says something precise; only these two learn
  // more from Word's own message — and a pending change can carry one too
  // (a view that could not scroll, say).
  const message =
    status === "pending" ||
    status === "view-only" ||
    status === "error" ||
    status === "historical"
      ? (error ?? statusCopy?.copy)
      : statusCopy?.copy;
  const messageClass =
    status === "pending" ? "text-amber-700" : (statusCopy?.className ?? "");

  return (
    <EditCardUI
      originalText={edit.original}
      replacementText={edit.replacement}
      reason={edit.reason}
      changeNumber={changeNumber}
      status={status}
      statusMessage={message}
      statusMessageClassName={messageClass}
      className={`${EDIT_CARD_SURFACE} p-3`}
      ariaBusy={
        status === "receiving" ||
        status === "applying" ||
        status === "restoring"
      }
      viewAction={
        status === "pending" || status === "view-only"
          ? {
              label: "View",
              onClick: onView,
              disabled: disabled || !onView,
            }
          : undefined
      }
      acceptAction={
        status === "pending"
          ? {
              label: "Accept",
              onClick: onAccept,
              disabled: disabled || !onAccept,
            }
          : undefined
      }
      rejectAction={
        status === "pending"
          ? {
              label: "Reject",
              onClick: onReject,
              disabled: disabled || !onReject,
            }
          : undefined
      }
    />
  );
}
