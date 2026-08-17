"use client";

import type { ReactNode } from "react";
import { PillButtonUI, type PillButtonUITone } from "./PillButtonUI";

export interface EditCardUIAction {
    label: string;
    onClick?: () => void;
    disabled?: boolean;
    title?: string;
}

export interface EditCardUIProps {
    originalText?: string;
    replacementText?: string;
    /**
     * Replaces the default red/green diff inside the text slab — for changes
     * that keep the text but restyle it (e.g. Word formatting cards).
     */
    previewContent?: ReactNode;
    reason?: string;
    changeNumber?: number;
    status?: string;
    statusMessage?: string;
    statusMessageClassName?: string;
    ariaBusy?: boolean;
    className?: string;
    actionOrder?: "resolve-first" | "view-first";
    viewAction?: EditCardUIAction;
    acceptAction?: EditCardUIAction;
    rejectAction?: EditCardUIAction;
}

function ActionButton({
    action,
    tone,
    className = "",
}: {
    action: EditCardUIAction;
    tone: PillButtonUITone;
    className?: string;
}) {
    return (
        <PillButtonUI
            tone={tone}
            onClick={action.onClick}
            disabled={action.disabled}
            title={action.title}
            className={className}
        >
            {action.label}
        </PillButtonUI>
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
    changeNumber,
    status,
    statusMessage,
    statusMessageClassName = "",
    ariaBusy = false,
    className = "",
    actionOrder = "resolve-first",
    viewAction,
    acceptAction,
    rejectAction,
}: EditCardUIProps) {
    const hasEditText =
        replacementText !== undefined || originalText !== undefined;
    const hasReplacement =
        replacementText !== undefined && replacementText !== "";
    const hasOriginal = originalText !== undefined && originalText !== "";
    const hasResolveActions = !!acceptAction || !!rejectAction;
    const hasActions = !!viewAction || hasResolveActions;

    const resolveActions = hasResolveActions ? (
        <div className="flex gap-2">
            {acceptAction && (
                <ActionButton action={acceptAction} tone="blue" />
            )}
            {rejectAction && (
                <ActionButton action={rejectAction} tone="white" />
            )}
        </div>
    ) : null;

    return (
        <div
            className={className}
            data-edit-status={status}
            aria-busy={ariaBusy || undefined}
        >
            {(changeNumber !== undefined || reason) && (
                <div className="mb-2 flex items-start gap-2">
                    {changeNumber !== undefined && (
                        <span
                            aria-label={`Tracked change ${changeNumber}`}
                            title={`Tracked change ${changeNumber}`}
                            className="inline-flex h-4 w-4 shrink-0 self-center items-center justify-center rounded-full bg-gray-200 text-[9px] font-medium leading-none text-gray-600"
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

            {hasActions && actionOrder === "view-first" && (
                <div
                    className="mt-3 flex items-center justify-between gap-2"
                    role="group"
                    aria-label="Edit actions"
                >
                    {viewAction && (
                        <ActionButton action={viewAction} tone="white" />
                    )}
                    {resolveActions}
                </div>
            )}

            {hasActions && actionOrder === "resolve-first" && (
                <div
                    className="mt-2 flex gap-2"
                    role="group"
                    aria-label="Edit actions"
                >
                    {resolveActions}
                    {viewAction && (
                        <ActionButton
                            action={viewAction}
                            tone="black"
                            className="ml-auto"
                        />
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
