import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/app/lib/utils";

export const GLASS_CARD_SURFACE_CLASS =
    "rounded-xl border border-white/70 bg-white/55 shadow-[0_3px_9px_rgba(15,23,42,0.03),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-4px_9px_rgba(255,255,255,0.05)] backdrop-blur-2xl";

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
