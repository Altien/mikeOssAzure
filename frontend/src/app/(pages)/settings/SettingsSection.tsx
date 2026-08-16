import type { ReactNode } from "react";
import { GlassCard } from "@/app/components/ui/glass-card";

export function SettingsSection({ children }: { children: ReactNode }) {
    return <GlassCard>{children}</GlassCard>;
}
