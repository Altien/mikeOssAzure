import type { ReactNode } from "react";

// Upstream's liquid-surface styling is replaced by dev's plain overlay
// (frontend refactor deferred, KNOWLEDGE §5). Sync-log: 6ae1f98d.
export function TRExpandedCellSurface({ children }: { children: ReactNode }) {
    return (
        <div className="absolute left-0 top-0 z-50 w-full bg-white border border-gray-200 shadow-lg rounded-sm">
            {children}
        </div>
    );
}
