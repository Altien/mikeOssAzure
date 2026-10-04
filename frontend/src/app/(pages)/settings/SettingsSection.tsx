import type { ReactNode } from "react";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";

export function SettingsSection({ children }: { children: ReactNode }) {
    return <GlassCardUI>{children}</GlassCardUI>;
}
