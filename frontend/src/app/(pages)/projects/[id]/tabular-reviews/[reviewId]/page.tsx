import { TRView } from "@/app/components/tabular/TabularReviewView";

// See app/(pages)/projects/[id]/page.tsx for why we don't pass ids —
// usePathname() inside TRView reads the real URL.
export function generateStaticParams() {
    return [{ id: "_", reviewId: "_" }];
}

export default function ProjectTabularReviewPage() {
    return <TRView />;
}
