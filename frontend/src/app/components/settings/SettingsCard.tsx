import type { ReactNode } from "react";
import { GlassCard } from "@/app/components/ui/glass-card";

export function SettingsCard({ children }: { children: ReactNode }) {
  return <GlassCard>{children}</GlassCard>;
}
