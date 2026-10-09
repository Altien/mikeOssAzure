"use client";

import { TRView } from "@/app/components/tabular/TabularReviewView";
import { usePathParams } from "@/app/lib/usePathParams";

export default function TabularReviewPage() {
    // Static-export divergence (OSS-6): id from the live URL instead of
    // `use(params)` (always "_" under output: "export"; see layout.tsx).
    const { id } = usePathParams<"id">("/tabular-reviews/:id");
    return <TRView reviewId={id} />;
}
