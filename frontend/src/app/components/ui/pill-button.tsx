"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import {
    PillButtonUI,
    pillButtonUIClassName,
    type PillButtonUISize,
    type PillButtonUITone,
} from "@/shared/ui/PillButtonUI";

type PillButtonProps = React.ComponentProps<"button"> & {
    asChild?: boolean;
    tone: PillButtonUITone;
    size?: PillButtonUISize;
};

export function PillButton({
    asChild = false,
    tone,
    size = "sm",
    type = "button",
    className,
    ...props
}: PillButtonProps) {
    if (!asChild) {
        return (
            <PillButtonUI
                type={type}
                tone={tone}
                size={size}
                className={className}
                {...props}
            />
        );
    }

    return (
        <Slot
            className={pillButtonUIClassName({ tone, size, className })}
            {...props}
        />
    );
}
