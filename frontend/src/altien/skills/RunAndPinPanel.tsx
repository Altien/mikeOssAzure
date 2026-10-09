import { Play } from "lucide-react";
import type { Document, Project } from "@/app/components/shared/types";
import type { SkillListItem } from "./api";

/**
 * Controls for an enabled skill: pick a project, optionally narrow which of
 * its documents the run may read (story 30), run it, pin the version to that
 * project, or (for admins) disable the skill.
 */
export function RunAndPinPanel({
    skill,
    busy,
    canManage,
    projects,
    selectedProjectId,
    projectDocuments,
    selectedDocumentIds,
    onProjectChange,
    onDocumentsChange,
    onRun,
    onPin,
    onDisable,
}: {
    skill: SkillListItem;
    busy: boolean;
    canManage: boolean;
    projects: Project[];
    selectedProjectId: string;
    projectDocuments: Document[];
    selectedDocumentIds: string[];
    onProjectChange: (projectId: string) => void;
    onDocumentsChange: (documentIds: string[]) => void;
    onRun: (skill: SkillListItem) => void;
    onPin: (skill: SkillListItem) => void;
    onDisable: (skill: SkillListItem) => void;
}) {
    return (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
            <select
                aria-label={`Project for ${skill.displayName}`}
                value={selectedProjectId}
                onChange={(event) => onProjectChange(event.target.value)}
                className="min-w-44 rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
                <option value="">Select project…</option>
                {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                        {project.name}
                    </option>
                ))}
            </select>
            {selectedProjectId && projectDocuments.length > 0 && (
                <select
                    multiple
                    aria-label={`Documents for ${skill.displayName}`}
                    title="Optional: limit the skill to selected documents. None selected = whole project."
                    value={selectedDocumentIds}
                    onChange={(event) =>
                        onDocumentsChange(
                            Array.from(
                                event.target.selectedOptions,
                                (option) => option.value,
                            ),
                        )
                    }
                    className="min-w-44 max-w-72 rounded-md border border-slate-300 px-3 py-2 text-sm"
                    size={Math.min(projectDocuments.length, 4)}
                >
                    {projectDocuments.map((document) => (
                        <option key={document.id} value={document.id}>
                            {document.filename}
                        </option>
                    ))}
                </select>
            )}
            <button
                type="button"
                disabled={busy}
                onClick={() => onRun(skill)}
                className="inline-flex items-center gap-2 rounded-md bg-slate-950 px-3 py-2 text-sm text-white disabled:opacity-50"
            >
                <Play className="h-4 w-4" />
                Run skill
            </button>
            <button
                type="button"
                disabled={busy || !selectedProjectId}
                onClick={() => onPin(skill)}
                className="rounded-md border border-slate-300 px-3 py-2 text-sm disabled:opacity-50"
            >
                Pin this version
            </button>
            {canManage && (
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => onDisable(skill)}
                    className="rounded-md border border-red-200 px-3 py-2 text-sm text-red-700 disabled:opacity-50"
                >
                    Disable
                </button>
            )}
        </div>
    );
}
