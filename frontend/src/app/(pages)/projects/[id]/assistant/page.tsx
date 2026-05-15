import { ProjectPage } from "@/app/components/projects/ProjectPage";

export function generateStaticParams() {
    return [{ id: "_" }];
}

export default function ProjectAssistantPage() {
    return <ProjectPage />;
}
