"use client";

import { type ButtonHTMLAttributes, type ReactElement } from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export type GlassIconButtonUIProps = Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "className"
> & {
    className?: string;
    /** Required: the button is icon-only, so it has no text to name it. */
    "aria-label": string;
};

const BASE_CLASS =
    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/70 bg-white/55 text-gray-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.75),inset_0_-1px_0_rgba(255,255,255,0.55),0_6px_18px_rgba(15,23,42,0.08)] backdrop-blur-xl transition-colors hover:bg-white/75 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2";

export function glassIconButtonUIClassName(className?: string) {
    return twMerge(clsx(BASE_CLASS, className));
}

/** Canonical circular glass icon button (modal close, panel dismiss, …). */
export function GlassIconButtonUI({
    type = "button",
    className,
    ...props
}: GlassIconButtonUIProps): ReactElement {
    return (
        <button
            type={type}
            className={glassIconButtonUIClassName(className)}
            {...props}
        />
    );
}
