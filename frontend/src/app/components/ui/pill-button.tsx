"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import {
    PillButtonContentUI,
    PillButtonUI,
    pillButtonUIClassName,
    type PillButtonUISize,
    type PillButtonUITone,
} from "@/shared/ui/PillButtonUI";

type PillButtonProps = React.ComponentProps<"button"> & {
    asChild?: boolean;
    tone: PillButtonUITone;
    size?: PillButtonUISize;
    loading?: boolean;
};

export function PillButton({
    asChild = false,
    tone,
    size = "sm",
    type = "button",
    className,
    children,
    loading = false,
    disabled,
    "aria-busy": ariaBusy,
    ...props
}: PillButtonProps) {
    if (!asChild) {
        return (
            <PillButtonUI
                type={type}
                tone={tone}
                size={size}
                className={className}
                loading={loading}
                disabled={disabled}
                aria-busy={ariaBusy}
                {...props}
            >
                {children}
            </PillButtonUI>
        );
    }

    const child = React.Children.only(children);
    const slottedChild = React.isValidElement<{ children?: React.ReactNode }>(
        child,
    )
        ? React.cloneElement(
              child,
              undefined,
              <PillButtonContentUI loading={loading} size={size}>
                  {child.props.children}
              </PillButtonContentUI>,
          )
        : child;

    return (
        <Slot
            className={pillButtonUIClassName({ tone, size, className })}
            aria-busy={loading ? true : ariaBusy}
            aria-disabled={disabled || loading || undefined}
            data-loading={loading || undefined}
            {...props}
        >
            {slottedChild}
        </Slot>
    );
}
