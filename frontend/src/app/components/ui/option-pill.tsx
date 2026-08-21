"use client";

import type { ButtonHTMLAttributes, ReactElement } from "react";
import { cn } from "@/app/lib/utils";

export type OptionPillProps = ButtonHTMLAttributes<HTMLButtonElement>;

/** A compact removable option, distinct from an action button. */
export function OptionPill({
    type = "button",
    className,
    ...props
}: OptionPillProps): ReactElement {
    return (
        <button
            type={type}
            data-slot="option-pill"
            className={cn(
                "inline-flex max-w-full items-center justify-center gap-1.5 rounded-full bg-white px-2 py-1 text-xs font-normal text-gray-700 shadow-sm transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white",
                className,
            )}
            {...props}
        />
    );
}
