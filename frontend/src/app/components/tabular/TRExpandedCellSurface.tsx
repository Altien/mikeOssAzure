import type { ReactNode } from "react";

export function TRExpandedCellSurface({ children }: { children: ReactNode }) {
    return (
        <div className="absolute left-0 top-0 z-50 w-full rounded-xl bg-gray-50/95 shadow-[0_4px_12px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-10px_24px_rgba(255,255,255,0.18)] backdrop-blur-2xl">
            {children}
        </div>
    );
}
