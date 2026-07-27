import { ScanSearch } from "lucide-react";
import type {
    SkillListItem,
    SkillPendingAction,
    SkillSnapshotResult,
} from "./api";

type ContractAtom = {
    label?: string;
    intent?: string;
    mappedToolNames?: string[];
    reason?: string;
};

type ContractMapping = {
    requirement?: { name?: string; kind?: string; required?: boolean };
    status?: string;
    mappedToolNames?: string[];
    llmReason?: string;
    atoms?: ContractAtom[];
};

type ExecutionContract = {
    approvedToolNames?: string[];
    toolLabels?: Record<string, string>;
    projectRead?: boolean;
    mappings?: ContractMapping[];
};

function contractOf(action: SkillPendingAction) {
    return (action.payload.executionContract ?? {}) as ExecutionContract;
}

/**
 * Wire name -> display label, mirroring the backend's `labelForTool`. Only MCP
 * tools differ, and their wire name hides which server they came from, so the
 * label is the only readable form of the thing being approved.
 */
function labelForTool(
    name: string,
    labels: Record<string, string> | undefined,
): string {
    return labels?.[name] ?? name;
}

function labelTools(
    names: string[] | undefined,
    labels: Record<string, string> | undefined,
): string {
    return (names ?? []).map((name) => labelForTool(name, labels)).join(", ");
}

/**
 * Short human phrase per contract status, so the panel reads as a decision
 * rather than as an enum dump. `tone` drives the visual weight: anything not
 * plainly mapped has to catch a reviewer's eye.
 */
const STATUS_PHRASES: Record<string, { label: string; tone: string }> = {
    compatible: { label: "mapped", tone: "mapped" },
    llm_compatible: { label: "mapped", tone: "mapped" },
    dependency_compatible: { label: "bound skill", tone: "mapped" },
    admin_selected: { label: "you selected this", tone: "warn" },
    connection_required: { label: "needs a connector", tone: "warn" },
    not_executed: { label: "never executed here", tone: "warn" },
    not_provided: { label: "not provided here", tone: "warn" },
    proposed: { label: "needs approval", tone: "warn" },
    needs_admin_selection: { label: "you must choose", tone: "warn" },
    dependency_required: { label: "needs a skill binding", tone: "warn" },
    incompatible: { label: "no equivalent", tone: "blocked" },
    missing: { label: "not found", tone: "blocked" },
    model_requirement: { label: "model behaviour", tone: "neutral" },
    admin_rejected: { label: "you rejected this", tone: "neutral" },
};

/** Statuses that need no further reading: the requirement is covered. */
const PLAINLY_MAPPED = ["compatible", "llm_compatible", "dependency_compatible"];

const TONE_CLASSES: Record<string, string> = {
    mapped: "bg-emerald-100 text-emerald-800",
    warn: "bg-amber-200 text-amber-900",
    blocked: "bg-rose-100 text-rose-800",
    neutral: "bg-slate-200 text-slate-700",
};

/** Never renders nothing: an unrecognised status shows its raw wire value. */
function phraseFor(status: string) {
    return (
        STATUS_PHRASES[status] ?? {
            label: status || "unknown status",
            tone: "neutral",
        }
    );
}

const REASON_LIMIT = 160;

function truncate(text: string) {
    return text.length > REASON_LIMIT
        ? `${text.slice(0, REASON_LIMIT).trimEnd()}…`
        : text;
}

/**
 * Every requirement in the contract with what it actually resolved to. The
 * whole mapping is the thing under approval, so nothing here is filtered out —
 * a requirement silently marked compatible and mapped onto unrelated tools is
 * exactly the case this table exists to make visible.
 */
function CapabilityMappingTable({ contract }: { contract: ExecutionContract }) {
    const mappings = contract.mappings ?? [];
    if (!mappings.length) return null;
    return (
        <div className="mt-2">
            <p className="text-xs font-medium">
                Capability mapping ({mappings.length})
            </p>
            <div className="mt-1 max-h-72 w-full min-w-0 overflow-auto rounded-md border border-amber-200 bg-white/70">
                <ul className="divide-y divide-amber-100">
                    {mappings.map((mapping, index) => {
                        const status = String(mapping.status ?? "");
                        const phrase = phraseFor(status);
                        const plain = PLAINLY_MAPPED.includes(status);
                        const tools = labelTools(
                            mapping.mappedToolNames,
                            contract.toolLabels,
                        );
                        const atoms = mapping.atoms ?? [];
                        return (
                            <li
                                key={`${mapping.requirement?.name ?? "requirement"}-${index}`}
                                className={
                                    plain
                                        ? "px-2 py-1.5"
                                        : "border-l-2 border-amber-500 bg-amber-100/60 px-2 py-1.5"
                                }
                            >
                                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                                    <span className="break-words text-xs font-medium">
                                        {mapping.requirement?.name ??
                                            "unnamed requirement"}
                                    </span>
                                    {mapping.requirement?.required === false && (
                                        <span className="text-[10px] uppercase tracking-wide text-slate-500">
                                            optional
                                        </span>
                                    )}
                                    <span
                                        className={`rounded px-1.5 py-0.5 text-[10px] ${TONE_CLASSES[phrase.tone] ?? TONE_CLASSES.neutral}`}
                                    >
                                        {phrase.label}
                                    </span>
                                </div>
                                <p className="mt-0.5 break-all font-mono text-[11px] text-slate-600">
                                    {tools || "no tools"}
                                </p>
                                {atoms.length > 0 && (
                                    <ul className="mt-1 space-y-0.5 border-l border-amber-300 pl-2">
                                        {atoms.map((atom, atomIndex) => {
                                            const atomTools = labelTools(
                                                atom.mappedToolNames,
                                                contract.toolLabels,
                                            );
                                            return (
                                                <li
                                                    key={`${atom.label ?? "atom"}-${atomIndex}`}
                                                    className="break-words text-[11px] text-slate-700"
                                                    title={atom.reason}
                                                >
                                                    {atom.label ?? "behaviour"}{" "}
                                                    <span aria-hidden="true">
                                                        →
                                                    </span>{" "}
                                                    <span className="break-all font-mono text-slate-600">
                                                        {atomTools ||
                                                            "no equivalent"}
                                                    </span>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                )}
                                {mapping.llmReason && (
                                    <p
                                        className="mt-0.5 break-words text-[11px] text-slate-500"
                                        title={mapping.llmReason}
                                    >
                                        {truncate(mapping.llmReason)}
                                    </p>
                                )}
                            </li>
                        );
                    })}
                </ul>
            </div>
        </div>
    );
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
        <div className="min-w-0">
            <p>Confirm the exact pending enable action.</p>
            <p className="mt-1">
                Approved tools:{" "}
                <span className="break-all font-mono">
                    {contract.approvedToolNames?.length
                        ? labelTools(
                              contract.approvedToolNames,
                              contract.toolLabels,
                          )
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
                                : `“${mapping.requirement?.name}” has the unapproved name-match candidate ${labelTools(mapping.mappedToolNames, contract.toolLabels)}.`}
                        </li>
                    ))}
                </ul>
            )}
            <CapabilityMappingTable contract={contract} />
        </div>
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
    // An enabled version is immutable — its approved contract is bound to the
    // analysis it was reviewed against. Disabling is the way back to review,
    // and without it a disabled version had no route forward at all.
    const reviewable =
        skill.version.state === "draft" || skill.version.state === "disabled";
    return (
        <>
            <p className="text-xs text-slate-500">
                Analysis: {skill.version.analysisState}
                {skill.version.analysisModel
                    ? ` · ${skill.version.analysisModel}`
                    : ""}
            </p>
            {skill.version.state === "disabled" && (
                <p className="mt-1 text-xs text-slate-500">
                    Disabled: no project can reach it. Re-analyse and propose to
                    put a rebuilt contract back in front of you.
                </p>
            )}
            {reviewable && (
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
            {reviewable &&
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
                    <div className="mt-3 min-w-0 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
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
            {reviewable && (
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
