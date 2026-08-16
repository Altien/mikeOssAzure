"use client";

export interface EditCardUIAction {
    label: string;
    onClick?: () => void;
    disabled?: boolean;
    title?: string;
}

export interface EditCardUIProps {
    originalText?: string;
    replacementText?: string;
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

const ACTION_BUTTON_BASE =
    "inline-flex items-center justify-center gap-1.5 rounded-full border px-2 py-1 text-xs font-medium transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100";

const ACTION_BUTTON_TONES = {
    black: "border-0 bg-gray-950/88 text-white shadow-[0_3px_9px_rgba(15,23,42,0.10),inset_1px_1px_0_rgba(255,255,255,0.22),inset_-1px_-1px_0_rgba(255,255,255,0.10),inset_-4px_-4px_9px_rgba(15,23,42,0.2)] backdrop-blur-xl hover:bg-gray-900/90 disabled:hover:bg-gray-950/88",
    white: "border-transparent bg-white text-gray-700 shadow-sm hover:bg-gray-100 disabled:hover:bg-white",
    blue: "border-0 bg-blue-600/90 text-white shadow-[0_3px_9px_rgba(37,99,235,0.10),inset_1px_1px_0_rgba(255,255,255,0.28),inset_-1px_-1px_0_rgba(255,255,255,0.14),inset_-4px_-4px_9px_rgba(29,78,216,0.2)] backdrop-blur-xl hover:bg-blue-600 disabled:hover:bg-blue-600/90",
} as const;

function ActionButton({
    action,
    tone,
    className = "",
}: {
    action: EditCardUIAction;
    tone: keyof typeof ACTION_BUTTON_TONES;
    className?: string;
}) {
    return (
        <button
            type="button"
            onClick={action.onClick}
            disabled={action.disabled}
            title={action.title}
            className={`${ACTION_BUTTON_BASE} ${ACTION_BUTTON_TONES[tone]} ${className}`}
        >
            {action.label}
        </button>
    );
}

/**
 * Platform-neutral tracked-change card. Data loading, authentication, document
 * mutation, and status transitions belong to the host wrapper.
 */
export function EditCardUI({
    originalText,
    replacementText,
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

            {hasEditText && (
                <div className="rounded-lg bg-gray-100/70 px-2 py-2 font-sans text-xs leading-relaxed">
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
