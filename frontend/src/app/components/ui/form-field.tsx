"use client";

import {
    forwardRef,
    type HTMLAttributes,
    type InputHTMLAttributes,
    type ReactNode,
} from "react";
import { cn } from "@/app/lib/utils";

// `outline-none` removes the browser's focus indicator, so every variant has to
// supply its own `focus-visible:` ring or the field becomes unusable by keyboard.
const FOCUS_RING_CLASS =
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2";

export const FORM_CONTROL_GLASS_CLASS =
    `w-full rounded-xl border border-white/70 bg-white px-3 text-sm text-gray-700 shadow-[0_3px_9px_rgba(15,23,42,0.052),inset_0_1px_0_rgba(255,255,255,0.86),inset_0_-1px_0_rgba(255,255,255,0.58)] outline-none placeholder:text-gray-400 backdrop-blur-xl transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_RING_CLASS}`;

type FormTextInputVariant = "glass" | "minimal";

type FormTextInputProps = InputHTMLAttributes<HTMLInputElement> & {
    variant?: FormTextInputVariant;
};

const variantClasses: Record<FormTextInputVariant, string> = {
    glass: cn("h-10", FORM_CONTROL_GLASS_CLASS),
    minimal: cn(
        "w-full rounded bg-transparent font-serif text-2xl text-gray-800 outline-none placeholder:text-gray-300 disabled:cursor-not-allowed disabled:text-gray-400",
        FOCUS_RING_CLASS,
    ),
};

export const FormTextInput = forwardRef<HTMLInputElement, FormTextInputProps>(
    ({ className, variant = "glass", ...props }, ref) => (
        <input
            ref={ref}
            className={cn(variantClasses[variant], className)}
            {...props}
        />
    ),
);

FormTextInput.displayName = "FormTextInput";

// Element-agnostic so the same props spread onto a label, p or span.
type FieldLabelProps = Omit<HTMLAttributes<HTMLElement>, "className"> & {
    children: ReactNode;
    as?: "label" | "p" | "span";
    htmlFor?: string;
};

export function FieldLabel({
    as = "label",
    children,
    htmlFor,
    ...props
}: FieldLabelProps) {
    const classes = "mb-2 block text-sm font-medium text-gray-700";

    // The non-label variants still need forwarded props: `id` is what lets a
    // caller point `aria-labelledby` at them.
    if (as === "p")
        return (
            <p className={classes} {...props}>
                {children}
            </p>
        );
    if (as === "span")
        return (
            <span className={classes} {...props}>
                {children}
            </span>
        );

    return (
        <label className={classes} htmlFor={htmlFor} {...props}>
            {children}
        </label>
    );
}
