"use client";

import * as React from "react";
import { cn } from "@/app/lib/utils";
import {
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_SUBTLE_CLASS,
} from "@/shared/ui/LiquidGlassUI";

type TabPillButtonProps = React.ComponentProps<"button"> & {
    active?: boolean;
};

export function TabPillButton({
    active,
    type = "button",
    className,
    ...props
}: TabPillButtonProps) {
    const stateClass =
        active === true
            ? "border-white/80 bg-white text-gray-900"
            : active === false
              ? `${LIQUID_GLASS_HOVER_CLASS} text-gray-400 hover:text-gray-700`
              : `${LIQUID_GLASS_HOVER_CLASS} text-gray-700 hover:text-gray-900`;

    return (
        <button
            data-slot="tab-pill-button"
            type={type}
            aria-pressed={active}
            className={cn(
                `inline-flex h-7 items-center justify-center gap-1.5 rounded-full px-3 text-xs font-medium ${LIQUID_GLASS_SUBTLE_CLASS} backdrop-blur-xl transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-40 disabled:active:scale-100`,
                stateClass,
                className,
            )}
            {...props}
        />
    );
}
