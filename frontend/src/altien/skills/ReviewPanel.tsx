import { ScanSearch } from "lucide-react";
import type {
    SkillListItem,
    SkillPendingAction,
    SkillSnapshotResult,
} from "./api";

type ContractMapping = {
    requirement?: { name?: string };
    status?: string;
    mappedToolNames?: string[];
};

function contractOf(action: SkillPendingAction) {
    return (action.payload.executionContract ?? {}) as {
        approvedToolNames?: string[];
        projectRead?: boolean;
        mappings?: ContractMapping[];
    };
}

/** Human-readable rendering of one read-only snapshot command result. */
export function formatSnapshotResult(result: SkillSnapshotResult): string {
    if (Array.isArray(result)) {
        return result
            .map(
                (entry) =>
                    `${entry.path} — ${entry.bytes} bytes${entry.readable ? "" : ` (inert: ${entry.inert_reason})`}`,
            )
            .join("\n");
    }
    if ("matches" in result) {
        return result.matches.length
            ? result.matches
                  .map((match) => `${match.path} @${match.offset}: ${match.context}`)
                  .join("\n")
            : "No snapshot text matched.";
    }
    return `${result.path}${result.truncated ? " (truncated)" : ""}\n${result.text}`;
}

function PendingActionDetail({ action }: { action: SkillPendingAction }) {
    if (action.actionType === "acquire_dependency") {
        const payload = action.payload as {
            dependencyName?: string;
            repository?: string;
            ref?: string | null;
            path?: string | null;
        };
        return (
            <p>
                Authorize acquisition of “{payload.dependencyName}” from{" "}
                <span className="font-mono">{payload.repository}</span>
                {payload.ref ? ` at ref ${payload.ref}` : ""}
                {payload.path ? `, path ${payload.path}` : ""}. Nothing is
                fetched until you approve, and the result is a draft that still
                needs review and an explicit dependency binding.
            </p>
        );
    }
    if (action.actionType === "rename_skill") {
        const payload = action.payload as { newDisplayName?: string };
        return (
            <p>
                Rename this draft to “{payload.newDisplayName}”. Approving
                rewrites the adapted tree and resets analysis.
            </p>
        );
    }
    if (action.actionType === "link_prior_skill") {
        const payload = action.payload as { priorCanonicalName?: string };
        return (
            <p>
                Make this draft a new version of “{payload.priorCanonicalName}”.
            </p>
        );
    }
    const contract = contractOf(action);
    const unresolved = (contract.mappings ?? []).filter((mapping) =>
        ["needs_admin_selection", "proposed"].includes(String(mapping.status)),
    );
    return (
        <>
            <p>Confirm the exact pending enable action.</p>
            <p className="mt-1">
                Approved tools:{" "}
                <span className="font-mono">
                    {contract.approvedToolNames?.length
                        ? contract.approvedToolNames.join(", ")
                        : "none"}
                </span>
                {contract.projectRead ? " · project read baseline on" : ""}
            </p>
            {unresolved.length > 0 && (
                <ul className="mt-1 list-disc pl-4">
                    {unresolved.map((mapping) => (
                        <li key={String(mapping.requirement?.name)}>
                            {mapping.status === "needs_admin_selection"
                                ? `“${mapping.requirement?.name}” grants nothing until you select a minimum capability set.`
                                : `“${mapping.requirement?.name}” has the unapproved name-match candidate ${(mapping.mappedToolNames ?? []).join(", ")}.`}
                        </li>
                    ))}
                </ul>
            )}
        </>
    );
}

/**
 * Admin review controls for one skill version: analysis state, the analyse
 * trigger, the propose/amend/approve/reject handshake for the exact pending
 * action, and read-only snapshot commands.
 */
export function ReviewPanel({
    skill,
    busy,
    pendingAction,
    amendValue,
    onAmendChange,
    onAmend,
    snapshotValue,
    onSnapshotChange,
    onSnapshotCommand,
    snapshotOutput,
    onAnalyse,
    onProposeEnable,
    onConfirmPending,
    onRejectPending,
}: {
    skill: SkillListItem;
    busy: boolean;
    pendingAction?: SkillPendingAction;
    amendValue: string;
    onAmendChange: (value: string) => void;
    onAmend: (versionId: string) => void;
    snapshotValue: string;
    onSnapshotChange: (value: string) => void;
    onSnapshotCommand: (versionId: string) => void;
    snapshotOutput?: string;
    onAnalyse: (versionId: string) => void;
    onProposeEnable: (versionId: string) => void;
    onConfirmPending: (versionId: string) => void;
    onRejectPending: (versionId: string) => void;
}) {
    return (
        <>
            <p className="text-xs text-slate-500">
                Analysis: {skill.version.analysisState}
                {skill.version.analysisModel
                    ? ` · ${skill.version.analysisModel}`
                    : ""}
            </p>
            {skill.version.state === "draft" && (
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => onAnalyse(skill.version.id)}
                    className="mt-3 inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
                    // Re-analysing discards any pending action, because the
                    // contract was reviewed against the previous findings.
                    title={
                        skill.version.analysisState === "succeeded"
                            ? "Analyse again with the currently configured model. Any pending action is discarded."
                            : undefined
                    }
                >
                    <ScanSearch className="h-4 w-4" />
                    {skill.version.analysisState === "succeeded"
                        ? "Re-analyse"
                        : skill.version.analysisState === "failed"
                          ? "Retry analysis"
                          : "Analyse"}
                </button>
            )}
            {skill.version.state === "draft" &&
                skill.version.analysisState === "succeeded" &&
                (!pendingAction ? (
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
                        <PendingActionDetail action={pendingAction} />
                        <p className="mt-1 font-mono text-xs">
                            payload {pendingAction.payloadHash.slice(0, 12)}…
                        </p>
                        <div className="mt-2 flex gap-2">
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                    onConfirmPending(skill.version.id)
                                }
                                className="rounded-md bg-slate-950 px-3 py-2 text-white disabled:opacity-50"
                            >
                                {pendingAction.actionType === "enable_version"
                                    ? "Confirm enable"
                                    : "Approve action"}
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => onRejectPending(skill.version.id)}
                                className="rounded-md border border-amber-300 px-3 py-2 disabled:opacity-50"
                            >
                                Reject
                            </button>
                        </div>
                        {pendingAction.actionType === "enable_version" && (
                            <div className="mt-3">
                                <label
                                    className="block text-xs"
                                    htmlFor={`amend-${skill.version.id}`}
                                >
                                    Amend this action
                                </label>
                                <input
                                    id={`amend-${skill.version.id}`}
                                    value={amendValue}
                                    onChange={(event) =>
                                        onAmendChange(event.target.value)
                                    }
                                    placeholder="amend tools a,b · amend allow <requirement> => a,b · amend reject <requirement> · amend rename <name>"
                                    className="mt-1 w-full rounded-md border border-amber-300 px-2 py-1 text-xs"
                                />
                                <button
                                    type="button"
                                    disabled={busy || !amendValue.trim()}
                                    onClick={() => onAmend(skill.version.id)}
                                    className="mt-2 rounded-md border border-amber-300 px-3 py-2 disabled:opacity-50"
                                >
                                    Propose amendment
                                </button>
                            </div>
                        )}
                    </div>
                ))}
            {skill.version.state === "draft" && (
                <div className="mt-3">
                    <label
                        className="block text-xs text-slate-500"
                        htmlFor={`snapshot-${skill.version.id}`}
                    >
                        Inspect snapshot (read-only)
                    </label>
                    <input
                        id={`snapshot-${skill.version.id}`}
                        value={snapshotValue}
                        onChange={(event) =>
                            onSnapshotChange(event.target.value)
                        }
                        placeholder="list · search <text> · read <path>"
                        className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-xs"
                    />
                    <button
                        type="button"
                        disabled={busy || !snapshotValue.trim()}
                        onClick={() => onSnapshotCommand(skill.version.id)}
                        className="mt-2 rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
                    >
                        Run snapshot command
                    </button>
                    {snapshotOutput && (
                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 p-2 text-xs text-slate-700">
                            {snapshotOutput}
                        </pre>
                    )}
                </div>
            )}
        </>
    );
}
