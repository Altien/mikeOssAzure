"use client";

import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { AlertCircle, X } from "lucide-react";
import { GlassIconButton } from "@/app/components/ui/glass-icon-button";
import { PillButton } from "@/app/components/ui/pill-button";
import { cn } from "@/app/lib/utils";

interface WarningPopupAction {
    label: ReactNode;
    onClick: () => void;
    disabled?: boolean;
}

interface WarningPopupProps {
    open: boolean;
    onClose: () => void;
    title?: ReactNode;
    message?: ReactNode;
    children?: ReactNode;
    icon?: ReactNode;
    primaryAction?: WarningPopupAction;
    className?: string;
}

export function WarningPopup({
    open,
    onClose,
    title,
    message,
    children,
    icon,
    primaryAction,
    className,
}: WarningPopupProps) {
    if (!open) return null;

    const warningIcon = icon ?? (
        <AlertCircle className="h-3 w-3 shrink-0 text-red-600" />
    );

    return createPortal(
        <div className="pointer-events-none fixed left-1/2 top-5 z-[220] w-[min(92vw,520px)] -translate-x-1/2 px-4">
            <div
                className={cn(
                    "pointer-events-auto relative flex rounded-2xl border border-white/70 bg-white px-3 py-3 text-xs shadow-[0_4px_12px_rgba(15,23,42,0.11),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-6px_12px_rgba(255,255,255,0.2)] backdrop-blur-2xl",
                    className,
                )}
            >
                <div className="min-w-0 flex-1 text-red-600">
                    {title && (
                        <div className="mb-1 flex items-center gap-1.5 text-sm font-medium">
                            {warningIcon}
                            {title}
                        </div>
                    )}
                    {message && (
                        <div
                            className={cn(
                                "text-black",
                                title
                                    ? "pl-[18px]"
                                    : "flex items-start gap-1.5",
                            )}
                        >
                            {!title && warningIcon}
                            <span className="min-w-0">{message}</span>
                        </div>
                    )}
                    {children}
                    {primaryAction && (
                        <div className="mt-2 flex items-center justify-end">
                            <PillButton
                                tone="black"
                                size="sm"
                                onClick={primaryAction.onClick}
                                disabled={primaryAction.disabled}
                            >
                                {primaryAction.label}
                            </PillButton>
                        </div>
                    )}
                </div>
                <GlassIconButton
                    onClick={onClose}
                    className="absolute right-1.5 top-1.5 h-5 w-5"
                    aria-label="Dismiss warning"
                >
                    <X className="h-3 w-3" />
                </GlassIconButton>
            </div>
        </div>,
        document.body,
    );
}
