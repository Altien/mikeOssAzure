import { ReviewsSection } from "./ReviewsSection";

export function generateStaticParams() {
    return [{ id: "_" }];
}

// Server stub for `output: "export"`; the real id is read client-side from
// the URL via the workspace context (see ReviewsSection).
export default function ProjectTabularReviewsPage() {
    return <ReviewsSection />;
}
