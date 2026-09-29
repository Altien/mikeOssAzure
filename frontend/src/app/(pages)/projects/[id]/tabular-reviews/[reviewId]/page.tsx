"use client";

import { TRView } from "@/app/components/tabular/TabularReviewView";
import { usePathParams } from "@/app/lib/usePathParams";

export default function ProjectTabularReviewPage() {
    // Static-export divergence (OSS-6): ids from the live URL instead of
    // `use(params)` (always "_" under output: "export"; see layout.tsx).
    const { id, reviewId } = usePathParams<"id" | "reviewId">(
        "/projects/:id/tabular-reviews/:reviewId",
    );
    return <TRView reviewId={reviewId} projectId={id} />;
}
