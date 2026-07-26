import { ScanSearch } from "lucide-react";
import type { SkillListItem } from "./api";

/**
 * Admin review controls for one skill version: analysis state, the analyse
 * trigger, and the propose/confirm enable handshake.
 */
export function ReviewPanel({
    skill,
    busy,
    pendingEnable,
    onAnalyse,
    onProposeEnable,
    onConfirmEnable,
}: {
    skill: SkillListItem;
    busy: boolean;
    pendingEnable: boolean;
    onAnalyse: (versionId: string) => void;
    onProposeEnable: (versionId: string) => void;
    onConfirmEnable: (versionId: string) => void;
}) {
    return (
        <>
            <p className="text-xs text-slate-500">
                Analysis: {skill.version.analysisState}
                {skill.version.analysisModel
                    ? ` · ${skill.version.analysisModel}`
                    : ""}
            </p>
            {skill.version.state === "draft" &&
                skill.version.analysisState !== "succeeded" && (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => onAnalyse(skill.version.id)}
                        className="mt-3 inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
                    >
                        <ScanSearch className="h-4 w-4" />
                        {skill.version.analysisState === "failed"
                            ? "Retry analysis"
                            : "Analyse"}
                    </button>
                )}
            {skill.version.state === "draft" &&
                skill.version.analysisState === "succeeded" &&
                (!pendingEnable ? (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => onProposeEnable(skill.version.id)}
                        className="mt-3 rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
                    >
                        Propose enable
                    </button>
                ) : (
                    <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                        <p>Confirm the exact pending enable action.</p>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => onConfirmEnable(skill.version.id)}
                            className="mt-2 rounded-md bg-slate-950 px-3 py-2 text-white disabled:opacity-50"
                        >
                            Confirm enable
                        </button>
                    </div>
                ))}
        </>
    );
}
