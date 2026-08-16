import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/app/lib/utils";

export const GLASS_CARD_SURFACE_CLASS =
    "rounded-xl border border-white/70 bg-white/55 shadow-sm backdrop-blur-2xl";

export function GlassCard({
    children,
    className,
    ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
    return (
        <div className={cn(GLASS_CARD_SURFACE_CLASS, className)} {...props}>
            {children}
        </div>
    );
}
