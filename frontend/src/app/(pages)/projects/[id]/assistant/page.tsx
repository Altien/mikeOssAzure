import { AssistantSection } from "./AssistantSection";

export function generateStaticParams() {
    return [{ id: "_" }];
}

// Server stub for `output: "export"`; the real id is read client-side from
// the URL via the workspace context (see AssistantSection).
export default function ProjectAssistantPage() {
    return <AssistantSection />;
}
