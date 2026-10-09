"use client";

import type { ReactNode } from "react";
import { PreResponseWrapperUI } from "@/shared/ui/PreResponseWrapperUI";

export function PreResponseWrapper({
    children,
    stepCount,
    shouldMinimize,
    isStreaming,
    forceOpen = false,
}: {
    children: ReactNode;
    stepCount: number;
    shouldMinimize: boolean;
    isStreaming: boolean;
    forceOpen?: boolean;
}) {
    return (
        <PreResponseWrapperUI
            stepCount={stepCount}
            shouldMinimize={shouldMinimize}
            isStreaming={isStreaming}
            forceOpen={forceOpen}
        >
            {children}
        </PreResponseWrapperUI>
    );
}
