import { ProjectPage } from "@/app/components/projects/ProjectPage";

export function generateStaticParams() {
    return [{ id: "_" }];
}

// We deliberately don't pass `id` from server-baked params — under
// `output: "export"` it's always the placeholder `"_"` regardless of
// the URL, because every browser nav resolves to the same prebaked
// shell. ProjectPage reads the real id from useParams() at runtime.
export default function ProjectDetailPage() {
    return <ProjectPage />;
}
