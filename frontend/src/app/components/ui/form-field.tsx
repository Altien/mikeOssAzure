"use client";

import {
    forwardRef,
    type ComponentPropsWithoutRef,
    type InputHTMLAttributes,
    type ReactNode,
} from "react";
import { cn } from "@/app/lib/utils";

export const FORM_CONTROL_GLASS_CLASS =
    "w-full rounded-xl border border-white/70 bg-white px-3 text-sm text-gray-700 shadow-[0_3px_9px_rgba(15,23,42,0.052),inset_0_1px_0_rgba(255,255,255,0.86),inset_0_-1px_0_rgba(255,255,255,0.58)] outline-none placeholder:text-gray-400 backdrop-blur-xl transition-colors disabled:cursor-not-allowed disabled:opacity-60";

type FormTextInputVariant = "glass" | "minimal";

type FormTextInputProps = InputHTMLAttributes<HTMLInputElement> & {
    variant?: FormTextInputVariant;
};

const variantClasses: Record<FormTextInputVariant, string> = {
    glass: cn("h-10", FORM_CONTROL_GLASS_CLASS),
    minimal:
        "w-full bg-transparent font-serif text-2xl text-gray-800 outline-none placeholder:text-gray-300 disabled:cursor-not-allowed disabled:text-gray-400",
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

type FieldLabelProps = ComponentPropsWithoutRef<"label"> & {
    children: ReactNode;
    as?: "label" | "p" | "span";
};

export function FieldLabel({
    as = "label",
    children,
    className,
    ...props
}: FieldLabelProps) {
    const classes = cn(
        "mb-2 block text-xs font-medium text-gray-700",
        className,
    );

    if (as === "p") return <p className={classes}>{children}</p>;
    if (as === "span") return <span className={classes}>{children}</span>;

    return (
        <label className={classes} {...props}>
            {children}
        </label>
    );
}
