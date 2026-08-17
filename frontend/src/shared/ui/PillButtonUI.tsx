"use client";

import {
    type ButtonHTMLAttributes,
    type ReactElement,
    type ReactNode,
} from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export type PillButtonUITone = "black" | "white" | "blue" | "danger";
export type PillButtonUISize = "sm" | "normal";

export type PillButtonUIProps = Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "className"
> & {
    children?: ReactNode;
    className?: string;
    tone: PillButtonUITone;
    size?: PillButtonUISize;
};

const toneClasses: Record<PillButtonUITone, string> = {
    black: "border-0 bg-gray-950/88 text-white shadow-[0_3px_9px_rgba(15,23,42,0.10),inset_1px_1px_0_rgba(255,255,255,0.22),inset_-1px_-1px_0_rgba(255,255,255,0.10),inset_-4px_-4px_9px_rgba(15,23,42,0.2)] backdrop-blur-xl hover:bg-gray-900/90 disabled:hover:bg-gray-950/88",
    white: "border-transparent bg-white text-gray-700 shadow-sm hover:bg-gray-100 disabled:hover:bg-white",
    blue: "border-0 bg-blue-600/90 text-white shadow-[0_3px_9px_rgba(37,99,235,0.10),inset_1px_1px_0_rgba(255,255,255,0.28),inset_-1px_-1px_0_rgba(255,255,255,0.14),inset_-4px_-4px_9px_rgba(29,78,216,0.2)] backdrop-blur-xl hover:bg-blue-600 disabled:hover:bg-blue-600/90",
    danger: "border-red-700/35 bg-red-600/90 text-white shadow-[0_3px_9px_rgba(127,29,29,0.10),inset_1px_1px_0_rgba(255,255,255,0.22),inset_-1px_-1px_0_rgba(255,255,255,0.12),inset_-4px_-4px_9px_rgba(127,29,29,0.18)] backdrop-blur-xl hover:bg-red-600 disabled:hover:bg-red-600/90",
};

const sizeClasses: Record<PillButtonUISize, string> = {
    sm: "px-2 py-1 text-xs",
    normal: "px-4 py-1.5 text-sm",
};

export function pillButtonUIClassName({
    tone,
    size = "sm",
    className,
}: {
    tone: PillButtonUITone;
    size?: PillButtonUISize;
    className?: string;
}) {
    return twMerge(
        clsx(
            "inline-flex items-center justify-center gap-1.5 rounded-full border font-medium transition-all active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100",
            toneClasses[tone],
            sizeClasses[size],
            className,
        ),
    );
}

/** Canonical pill button shared by the web app and Word add-in. */
export function PillButtonUI({
    tone,
    size = "sm",
    type = "button",
    className,
    ...props
}: PillButtonUIProps): ReactElement {
    return (
        <button
            type={type}
            className={pillButtonUIClassName({ tone, size, className })}
            {...props}
        />
    );
}
