import type { ReactNode } from "react";
import { LIQUID_GLASS_FLAT_CLASS } from "./LiquidGlassUI";

export const GLASS_CARD_SURFACE_CLASS =
    `rounded-xl ${LIQUID_GLASS_FLAT_CLASS} backdrop-blur-2xl`;

export function GlassCardUI({ children }: { children: ReactNode }) {
    return <div className={GLASS_CARD_SURFACE_CLASS}>{children}</div>;
}
