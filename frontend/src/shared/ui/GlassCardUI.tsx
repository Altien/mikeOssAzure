import type { ReactNode } from "react";

export const GLASS_CARD_SURFACE_CLASS =
    "rounded-xl border border-white/70 bg-white/55 shadow-sm backdrop-blur-2xl";

export function GlassCardUI({ children }: { children: ReactNode }) {
    return <div className={GLASS_CARD_SURFACE_CLASS}>{children}</div>;
}
