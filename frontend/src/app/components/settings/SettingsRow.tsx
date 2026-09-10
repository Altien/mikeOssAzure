import type { ReactNode } from "react";
import { cn } from "@/app/lib/utils";

export function SettingsRow({
  children,
  layout = "split",
}: {
  children: ReactNode;
  layout?: "split" | "stacked";
}) {
  return (
    <div
      data-slot="settings-row"
      className={cn(
        "flex min-w-0 flex-col gap-3 border-t border-gray-100 px-4 py-5 first:border-t-0",
        layout === "split" && "sm:flex-row sm:items-center sm:justify-between",
      )}
    >
      {children}
    </div>
  );
}
