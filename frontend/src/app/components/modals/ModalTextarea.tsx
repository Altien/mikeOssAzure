"use client";

import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "@/app/lib/utils";
import { LIQUID_GLASS_SUBTLE_CLASS } from "@/shared/ui/LiquidGlassUI";

type ModalTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const ModalTextarea = forwardRef<
    HTMLTextAreaElement,
    ModalTextareaProps
>(({ className, ...props }, ref) => (
    <textarea
        ref={ref}
        className={cn(
            `min-h-24 w-full resize-none rounded-xl px-3 py-2.5 text-sm leading-relaxed text-gray-700 ${LIQUID_GLASS_SUBTLE_CLASS} outline-none placeholder:text-gray-400 backdrop-blur-xl transition-colors disabled:cursor-not-allowed disabled:opacity-60`,
            className,
        )}
        {...props}
    />
));

ModalTextarea.displayName = "ModalTextarea";
