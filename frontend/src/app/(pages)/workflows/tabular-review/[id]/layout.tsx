import type { ReactNode } from "react";
import { RequirePathParams } from "@/app/lib/usePathParams";

// Upstream divergence (sync-log: 3132e04; OSS-6 decision 2): upstream has no
// layout here. `output: "export"` needs `generateStaticParams` for every
// dynamic segment, and a "use client" page cannot export it, so this server
// layout declares the single `"_"` placeholder shell and holds the page back
// until the real id is readable from the URL. The page body stays
// upstream's apart from its id line (usePathParams instead of `use(params)`).
export function generateStaticParams() {
    return [{ id: "_" }];
}

export default function TabularReviewWorkflowLayout({
    children,
}: {
    children: ReactNode;
}) {
    return (
        <RequirePathParams pattern="/workflows/tabular-review/:id">
            {children}
        </RequirePathParams>
    );
}
