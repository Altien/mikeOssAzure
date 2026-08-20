"use client";

import type { ButtonHTMLAttributes, ReactElement, ReactNode } from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export type CitationPillUIProps = Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "children" | "className"
> & {
    children: ReactNode;
    className?: string;
};

const BASE_CLASS_NAME =
    "inline-flex h-4 w-4 items-center justify-center rounded-full border border-gray-200/60 bg-gray-200/80 text-[12px] font-serif font-medium text-gray-800 shadow-[0_1px_2px_rgba(15,23,42,0.04),inset_0_1px_0_rgba(243,244,246,0.85),inset_0_-2px_4px_rgba(229,231,235,0.65)] backdrop-blur-xl transition-colors hover:bg-gray-200 hover:text-gray-950";

/** Canonical numbered citation control shared by web and Word surfaces. */
export function CitationPillUI({
    type = "button",
    className,
    ...props
}: CitationPillUIProps): ReactElement {
    return (
        <button
            type={type}
            className={twMerge(clsx(BASE_CLASS_NAME, className))}
            {...props}
        />
    );
}
