"use client";

import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/app/lib/utils";

export const SETTINGS_CONTROL_CLASS =
    "w-full rounded-lg border border-transparent bg-gray-100 px-3 text-sm text-gray-900 shadow-none outline-none placeholder:text-gray-400 transition-colors focus:border-gray-200 focus:ring-2 focus:ring-gray-300/45 disabled:cursor-not-allowed disabled:opacity-60";

export const SettingsTextInput = forwardRef<
    HTMLInputElement,
    InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
    <input
        ref={ref}
        className={cn("h-10", SETTINGS_CONTROL_CLASS, className)}
        {...props}
    />
));

SettingsTextInput.displayName = "SettingsTextInput";
