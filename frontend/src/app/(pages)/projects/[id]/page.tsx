import { DocumentsSection } from "./DocumentsSection";

export function generateStaticParams() {
    return [{ id: "_" }];
}

// Server stub: `output: "export"` needs one prebuilt shell per dynamic route.
// The real id is read client-side from the URL (see DocumentsSection /
// ProjectWorkspaceLayout) because server-baked params are always "_".
export default function ProjectDetailPage() {
    return <DocumentsSection />;
}
