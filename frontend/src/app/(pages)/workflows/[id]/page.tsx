import WorkflowDetailClient from "./WorkflowDetailClient";

// See app/(pages)/projects/[id]/page.tsx for why we don't pass id —
// usePathname() inside the client reads the real URL.
export function generateStaticParams() {
    return [{ id: "_" }];
}

export default function WorkflowDetailPage() {
    return <WorkflowDetailClient />;
}
