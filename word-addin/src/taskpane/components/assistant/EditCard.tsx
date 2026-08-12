import React from "react";
import type { RedlineEdit } from "../../lib/redline";
import { EDIT_CARD_SURFACE } from "./messageStyles";

export type EditCardStatus = "pending" | "applied" | "skipped";

/**
 * A single proposed tracked change, rendered with the web app's EditCard
 * look: reason line, then the replacement in green and the original in red
 * strikethrough on a serif gray slab. In the pane the card is
 * informational — the change is applied to the live document via the bulk
 * action, and Word's own Review ribbon handles accept/reject afterwards —
 * so instead of Accept/Reject controls it shows an applied/skipped state.
 */
export function EditCard({
  edit,
  changeNumber,
  status = "pending",
}: {
  edit: RedlineEdit;
  changeNumber?: number;
  status?: EditCardStatus;
}): React.ReactElement {
  return (
    <div className={`${EDIT_CARD_SURFACE} p-3`}>
      {changeNumber !== undefined && (
        <p className="text-xs text-gray-400 mb-1.5">{changeNumber}</p>
      )}
      {edit.reason && (
        <p className="text-xs text-gray-500 mb-2">{edit.reason}</p>
      )}
      <div className="text-sm leading-relaxed font-serif bg-gray-100/70 rounded-lg px-2 py-2">
        {edit.replacement && (
          <span className="text-green-700">{edit.replacement}</span>
        )}
        {edit.replacement && edit.original && " "}
        {edit.original && (
          <span className="text-red-600 line-through">{edit.original}</span>
        )}
      </div>
      {status !== "pending" && (
        <p
          className={`mt-2 text-xs ${status === "applied" ? "text-gray-500" : "text-red-500"}`}
        >
          {status === "applied"
            ? "Applied as a tracked change."
            : "Skipped — the quoted text was not found in the document."}
        </p>
      )}
    </div>
  );
}
