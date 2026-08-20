"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/app/lib/utils";

export type CheckSquareState = "checked" | "unchecked" | "indeterminate";

type CheckSquareProps = Omit<React.ComponentProps<"span">, "children"> & {
    state: CheckSquareState;
    /** Dims an unchecked square that cannot be selected yet. */
    muted?: boolean;
};

/**
 * The selection square used by directory and picker rows. It is a presentational
 * indicator: the surrounding row owns the interaction and the ARIA state, so this
 * is hidden from assistive tech by default. For a standalone control, prefer a
 * real `<input type="checkbox">`.
 */
export function CheckSquare({
    state,
    muted = false,
    className,
    role,
    ...props
}: CheckSquareProps) {
    const marked = state !== "unchecked";

    return (
        <span
            data-slot="check-square"
            data-state={state}
            role={role}
            // Decorative by default; a caller that gives it a role owns the
            // ARIA state itself and must stay visible to assistive tech.
            aria-hidden={role ? undefined : true}
            className={cn(
                "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                marked
                    ? "border-gray-900 bg-gray-900"
                    : muted
                      ? "border-gray-200 bg-gray-50"
                      : "border-gray-300",
                className,
            )}
            {...props}
        >
            {state === "checked" ? (
                <Check
                    data-slot="check-square-mark"
                    className="h-2.5 w-2.5 text-white"
                />
            ) : null}
            {state === "indeterminate" ? (
                <span
                    data-slot="check-square-dash"
                    className="h-px w-2 bg-white"
                />
            ) : null}
        </span>
    );
}
