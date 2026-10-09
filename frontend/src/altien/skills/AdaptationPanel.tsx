import type { SkillListItem } from "./api";

export type DraftArtifact = {
    id: string;
    filename: string;
    reviewPayloadHash: string;
};

/**
 * Admin controls that adapt an imported skill: rename into an adapted copy,
 * generate and approve a clean-room developer brief, and check the tracked
 * GitHub ref for updates.
 */
export function AdaptationPanel({
    skill,
    busy,
    renameValue,
    onRenameChange,
    onRename,
    requirementValue,
    onRequirementChange,
    onCreateDeveloperArtifact,
    updateMessage,
    onCheckUpdate,
    draftArtifact,
    onReviewArtifact,
    onApproveArtifact,
}: {
    skill: SkillListItem;
    busy: boolean;
    renameValue: string;
    onRenameChange: (value: string) => void;
    onRename: (skill: SkillListItem) => void;
    requirementValue: string;
    onRequirementChange: (value: string) => void;
    onCreateDeveloperArtifact: (skill: SkillListItem) => void;
    updateMessage: string | undefined;
    onCheckUpdate: (skill: SkillListItem) => void;
    draftArtifact: DraftArtifact | undefined;
    onReviewArtifact: (versionId: string, artifact: DraftArtifact) => void;
    onApproveArtifact: (versionId: string, artifact: DraftArtifact) => void;
}) {
    return (
        <>
            {skill.version.state === "draft" && (
                <div className="mt-3 flex flex-wrap gap-2">
                    <input
                        value={renameValue}
                        onChange={(event) => onRenameChange(event.target.value)}
                        placeholder={
                            skill.isUpdate
                                ? "Import update as…"
                                : "Rename as…"
                        }
                        aria-label={`Rename ${skill.displayName}`}
                        className="min-w-48 rounded-md border border-slate-300 px-3 py-2 text-sm"
                    />
                    <button
                        type="button"
                        disabled={busy || !renameValue.trim()}
                        onClick={() => onRename(skill)}
                        className="rounded-md border border-slate-300 px-3 py-2 text-sm disabled:opacity-50"
                    >
                        Apply to adapted copy
                    </button>
                </div>
            )}
            {skill.version.analysisState === "succeeded" &&
                !!skill.version.briefRequirements?.length && (
                <div className="mt-3 flex flex-wrap gap-2">
                    <input
                        value={requirementValue}
                        onChange={(event) =>
                            onRequirementChange(event.target.value)
                        }
                        list={`brief-requirements-${skill.version.id}`}
                        placeholder={`Requirement to specify, e.g. ${skill.version.briefRequirements[0]}`}
                        aria-label={`Clean-room requirement for ${skill.displayName}`}
                        className="min-w-64 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
                    />
                    <datalist id={`brief-requirements-${skill.version.id}`}>
                        {skill.version.briefRequirements.map((name) => (
                            <option key={name} value={name} />
                        ))}
                    </datalist>
                    <button
                        type="button"
                        disabled={busy || !requirementValue.trim()}
                        onClick={() => onCreateDeveloperArtifact(skill)}
                        className="rounded-md border border-slate-300 px-3 py-2 text-sm disabled:opacity-50"
                    >
                        Generate clean-room brief
                    </button>
                </div>
            )}
            {skill.version.sourceKind === "github" && (
                <div className="mt-3">
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => onCheckUpdate(skill)}
                        className="rounded-md border border-slate-300 px-3 py-2 text-sm disabled:opacity-50"
                    >
                        Check GitHub update
                    </button>
                    {updateMessage && (
                        <p className="mt-2 text-xs text-slate-600">
                            {updateMessage}
                        </p>
                    )}
                </div>
            )}
            {draftArtifact && (
                <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                    <p>
                        Review the downloaded clean-room brief before approving
                        it for the developer package.
                    </p>
                    <div className="mt-2 flex gap-2">
                        <button
                            type="button"
                            onClick={() =>
                                onReviewArtifact(skill.version.id, draftArtifact)
                            }
                            className="rounded-md border border-amber-300 px-3 py-2"
                        >
                            Download draft
                        </button>
                        <button
                            type="button"
                            onClick={() =>
                                onApproveArtifact(
                                    skill.version.id,
                                    draftArtifact,
                                )
                            }
                            className="rounded-md bg-slate-950 px-3 py-2 text-white"
                        >
                            Approve reviewed brief
                        </button>
                    </div>
                </div>
            )}
        </>
    );
}
