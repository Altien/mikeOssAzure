"use client";

import { Children, useState, type ReactNode } from "react";

export interface EditCardsSectionUIProps {
    summary: string;
    actions?: ReactNode;
    actionsLabel?: string;
    children: ReactNode;
    className?: string;
    defaultOpen?: boolean;
}

/**
 * Platform-neutral grouped-edit surface. Summary calculation and bulk action
 * behavior belong to the host wrapper; this component owns only presentation
 * and the local expanded/collapsed state.
 */
export function EditCardsSectionUI({
    summary,
    actions,
    actionsLabel = "Tracked change actions",
    children,
    className = "",
    defaultOpen = true,
}: EditCardsSectionUIProps) {
    const [isOpen, setIsOpen] = useState(defaultOpen);

    if (Children.count(children) === 1) {
        return <>{children}</>;
    }

    return (
        <div className={className}>
            <div className="flex items-center gap-2 px-3 pt-3">
                <p className="min-w-0 flex-1 truncate font-serif text-sm text-gray-700">
                    {summary}
                </p>
                <button
                    type="button"
                    onClick={() => setIsOpen((value) => !value)}
                    aria-label={isOpen ? "Collapse edits" : "Expand edits"}
                    aria-expanded={isOpen}
                    className="shrink-0 rounded p-1 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800"
                >
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        className={`h-4 w-4 transition-transform duration-200 ${isOpen ? "" : "-rotate-90"}`}
                    >
                        <path d="m6 9 6 6 6-6" />
                    </svg>
                </button>
            </div>

            {actions && (
                <div
                    className="flex flex-wrap items-center gap-2 px-3 pt-3"
                    role="group"
                    aria-label={actionsLabel}
                >
                    {actions}
                </div>
            )}

            {isOpen ? (
                <div className="flex flex-col gap-2 px-3 pb-3 pt-3">
                    {children}
                </div>
            ) : (
                <div className="pb-3" />
            )}
        </div>
    );
}
