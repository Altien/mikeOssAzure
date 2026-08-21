"use client";

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { PillButtonUI } from "./PillButtonUI";

export type EditCardUIBusyAction =
    | "view"
    | "apply"
    | "accept"
    | "reject"
    | "accept-and-apply";

export interface EditCardUIProps {
    originalText?: string;
    replacementText?: string;
    /**
     * Replaces the default red/green diff inside the text slab — for changes
     * that keep the text but restyle it (e.g. Word formatting cards).
     */
    previewContent?: ReactNode;
    reason?: string;
    /**
     * Where the change landed: a snippet of its surrounding passage, shown
     * under the diff so a wrong-location edit is catchable before Accept.
     */
    locationHint?: string;
    changeNumber?: number;
    status?: string;
    statusMessage?: string;
    statusMessageClassName?: string;
    ariaBusy?: boolean;
    className?: string;
    actionsDisabled?: boolean;
    busyAction?: EditCardUIBusyAction;
    onView?: () => void;
    onApply?: () => void;
    onAccept?: () => void;
    onReject?: () => void;
    onAcceptAndApply?: () => void;
}

function BusyLabel({ children }: { children: ReactNode }) {
    return (
        <>
            <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
            <span>{children}</span>
        </>
    );
}

/**
 * Platform-neutral tracked-change card. Data loading, authentication, document
 * mutation, and status transitions belong to the host wrapper.
 */
export function EditCardUI({
    originalText,
    replacementText,
    previewContent,
    reason,
    locationHint,
    changeNumber,
    status,
    statusMessage,
    statusMessageClassName = "",
    ariaBusy = false,
    className = "",
    actionsDisabled = false,
    busyAction,
    onView,
    onApply,
    onAccept,
    onReject,
    onAcceptAndApply,
}: EditCardUIProps) {
    const hasEditText =
        replacementText !== undefined || originalText !== undefined;
    const hasReplacement =
        replacementText !== undefined && replacementText !== "";
    const hasOriginal = originalText !== undefined && originalText !== "";
    const resolved = status === "accepted" || status === "rejected";
    const controlsDisabled = actionsDisabled || busyAction !== undefined;
    const showApply = !!onApply || busyAction === "apply";
    const showAcceptAndApply =
        !!onAcceptAndApply || busyAction === "accept-and-apply";
    const hasActions =
        !!onView ||
        showApply ||
        showAcceptAndApply ||
        !!onAccept ||
        !!onReject;

    return (
        <div
            className={className}
            data-edit-status={status}
            aria-busy={ariaBusy || busyAction !== undefined || undefined}
        >
            {(changeNumber !== undefined || reason) && (
                <div className="mb-2 flex items-start gap-2">
                    {changeNumber !== undefined && (
                        <span
                            aria-label={`Tracked change ${changeNumber}`}
                            title={`Tracked change ${changeNumber}`}
                            className="mt-0.5 inline-flex h-4 w-4 shrink-0 self-start items-center justify-center rounded-full bg-gray-200 text-[9px] font-medium leading-none text-gray-600"
                        >
                            {changeNumber}
                        </span>
                    )}
                    {reason && (
                        <p className="min-w-0 flex-1 font-serif text-sm text-gray-500">
                            {reason}
                        </p>
                    )}
                </div>
            )}

            {(hasEditText || previewContent !== undefined) && (
                <div className="rounded-lg bg-gray-100/70 px-2 py-2 font-sans text-xs leading-relaxed">
                    {previewContent !== undefined ? (
                        previewContent
                    ) : (
                        <>
                            {hasReplacement && (
                                <span className="text-green-700">
                                    {replacementText}
                                </span>
                            )}
                            {hasReplacement && hasOriginal && " "}
                            {hasOriginal && (
                                <span className="text-red-600 line-through">
                                    {originalText}
                                </span>
                            )}
                        </>
                    )}
                </div>
            )}

            {locationHint && (
                <p
                    className="mt-1 truncate font-sans text-[11px] text-gray-400"
                    title={locationHint}
                >
                    In: “{locationHint}”
                </p>
            )}

            {hasActions && (
                <div
                    className="mt-2 flex gap-2"
                    role="group"
                    aria-label="Edit actions"
                >
                    {showAcceptAndApply && (
                        <PillButtonUI
                            tone="blue"
                            onClick={onAcceptAndApply}
                            disabled={
                                controlsDisabled || !onAcceptAndApply
                            }
                        >
                            {busyAction === "accept-and-apply" ? (
                                <BusyLabel>
                                    Accepting &amp; applying...
                                </BusyLabel>
                            ) : (
                                "Accept & apply"
                            )}
                        </PillButtonUI>
                    )}
                    {showApply && (
                        <PillButtonUI
                            tone="blue"
                            onClick={onApply}
                            disabled={controlsDisabled || !onApply}
                        >
                            {busyAction === "apply" ? (
                                <BusyLabel>Applying...</BusyLabel>
                            ) : (
                                "Apply"
                            )}
                        </PillButtonUI>
                    )}
                    {onAccept && (
                        <PillButtonUI
                            tone="blue"
                            onClick={onAccept}
                            disabled={controlsDisabled || resolved}
                        >
                            {busyAction === "accept" ? (
                                <BusyLabel>Accepting...</BusyLabel>
                            ) : status === "accepted" ? (
                                "Accepted"
                            ) : (
                                "Accept"
                            )}
                        </PillButtonUI>
                    )}
                    {onReject && (
                        <PillButtonUI
                            tone="white"
                            onClick={onReject}
                            disabled={controlsDisabled || resolved}
                        >
                            {busyAction === "reject" ? (
                                <BusyLabel>Rejecting...</BusyLabel>
                            ) : status === "rejected" ? (
                                "Rejected"
                            ) : (
                                "Reject"
                            )}
                        </PillButtonUI>
                    )}
                    {onView && (
                        <PillButtonUI
                            tone="black"
                            onClick={onView}
                            disabled={controlsDisabled || resolved}
                            title={
                                resolved
                                    ? "This change has been resolved and is no longer in the document."
                                    : undefined
                            }
                            className="ml-auto"
                        >
                            View
                        </PillButtonUI>
                    )}
                </div>
            )}

            {statusMessage && (
                <p
                    className={`mt-2 text-xs ${statusMessageClassName}`}
                    role="status"
                >
                    {statusMessage}
                </p>
            )}
        </div>
    );
}
