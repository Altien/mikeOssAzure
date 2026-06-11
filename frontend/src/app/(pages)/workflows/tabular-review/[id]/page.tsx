import TabularReviewWorkflowClient from "./TabularReviewWorkflowClient";

// See app/(pages)/projects/[id]/page.tsx for why we don't pass id —
// usePathname() inside the client reads the real URL.
// Upstream divergence (sync-log: 3132e04): upstream's page is a client
// component using `use(params)`; under dev's output: "export" the params
// are the prerender's "_" placeholder, so dev keeps the server-wrapper +
// pathname-reading-client idiom instead.
export function generateStaticParams() {
    return [{ id: "_" }];
}

export default function TabularReviewWorkflowPage() {
    return <TabularReviewWorkflowClient />;
}
