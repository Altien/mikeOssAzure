"use client";

import * as React from "react";
import { cn } from "@/app/lib/utils";
import { PillButton } from "@/app/components/ui/pill-button";

type SettingsActionButtonProps = Omit<
    React.ComponentProps<typeof PillButton>,
    "tone"
>;

export function SettingsActionButton({
    size = "normal",
    className,
    ...props
}: SettingsActionButtonProps) {
    return (
        <PillButton
            tone="white"
            size={size}
            className={cn(
                "border-transparent bg-gray-100 shadow-none hover:bg-gray-200 disabled:hover:bg-gray-100",
                className,
            )}
            {...props}
        />
    );
}
