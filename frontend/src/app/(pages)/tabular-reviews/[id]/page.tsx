import { TRView } from "@/app/components/tabular/TabularReviewView";

// See app/(pages)/projects/[id]/page.tsx for why we don't pass id —
// usePathname() inside TRView reads the real URL.
export function generateStaticParams() {
    return [{ id: "_" }];
}

export default function TabularReviewPage() {
    return <TRView />;
}
