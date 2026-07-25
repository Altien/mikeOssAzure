"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
    getAuthorityTraceRun,
    saveAuthorityTraceReview,
    type AuthorityTraceCitation,
    type AuthorityTraceSegment,
    type AuthorityTraceVerdict,
    type AuthorityTraceWorkspace,
} from "@/app/lib/mikeApi";
import { cn } from "@/lib/utils";

function citationState(citation: AuthorityTraceCitation): {
    label: string;
    className: string;
} {
    if (citation.status === "no_quote_claimed") {
        return {
            label: "No quote claimed",
            className: "bg-slate-100 text-slate-700",
        };
    }
    if (citation.status === "anchor_failed") {
        const missing = citation.failure_reason === "source_missing";
        return {
            label: missing ? "Source missing" : "Failed",
            className: "bg-red-50 text-red-700",
        };
    }
    const formattingDiffers =
        citation.memo_anchor?.match !== "exact" ||
        citation.anchors.some((anchor) => anchor.match !== "exact");
    return formattingDiffers
        ? {
              label: "Formatting differs",
              className: "bg-amber-50 text-amber-800",
          }
        : {
              label: "Anchored",
              className: "bg-emerald-50 text-emerald-700",
          };
}

function SegmentedText({
    segments,
    citationId,
}: {
    segments: AuthorityTraceSegment[];
    citationId: string;
}) {
    return (
        <div className="whitespace-pre-wrap break-words font-serif text-sm leading-6 text-slate-800">
            {segments.map((segment, index) =>
                segment.highlights.includes(citationId) ? (
                    <mark
                        key={index}
                        className="rounded-sm bg-yellow-200 px-0.5 text-inherit"
                    >
                        {segment.text}
                    </mark>
                ) : (
                    <span key={index}>{segment.text}</span>
                ),
            )}
        </div>
    );
}

const VERDICTS: Array<{
    value: AuthorityTraceVerdict;
    label: string;
    key: string;
}> = [
    { value: "verified", label: "Verified", key: "V" },
    { value: "needs_attention", label: "Needs attention", key: "A" },
    { value: "rejected", label: "Rejected", key: "R" },
];

export function AuthorityTracePanel({ runId }: { runId: string }) {
    const [workspace, setWorkspace] =
        useState<AuthorityTraceWorkspace | null>(null);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [note, setNote] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            setWorkspace(await getAuthorityTraceRun(runId));
        } catch (reason) {
            setError(
                reason instanceof Error
                    ? reason.message
                    : "Failed to load Authority Trace",
            );
        } finally {
            setLoading(false);
        }
    }, [runId]);

    useEffect(() => {
        void load();
    }, [load]);

    const citations = workspace?.verified_record.citations ?? [];
    const selected = citations[selectedIndex] ?? null;
    const currentReview = selected
        ? workspace?.current_reviews[selected.id]
        : undefined;
    const staleReviews = selected
        ? (workspace?.reviews ?? []).filter(
              (review) =>
                  review.citation_id === selected.id && review.stale,
          )
        : [];

    useEffect(() => {
        setNote(currentReview?.note ?? "");
    }, [currentReview?.id, selected?.id]);

    const selectedSourceKey = useMemo(() => {
        if (!selected) return null;
        return (
            selected.anchors[0]?.source ??
            selected.source_candidates.find(
                (key) => workspace?.sources[key],
            ) ??
            null
        );
    }, [selected, workspace?.sources]);
    const selectedSource =
        selectedSourceKey && workspace
            ? workspace.sources[selectedSourceKey]
            : null;

    const move = useCallback(
        (delta: number) => {
            if (citations.length === 0) return;
            setSelectedIndex((index) =>
                Math.min(citations.length - 1, Math.max(0, index + delta)),
            );
        },
        [citations.length],
    );

    const saveVerdict = useCallback(
        async (verdict: AuthorityTraceVerdict) => {
            if (!selected || saving) return;
            setSaving(true);
            setError(null);
            try {
                await saveAuthorityTraceReview(runId, {
                    citation_id: selected.id,
                    binds_to: selected.binds_to,
                    verdict,
                    note: note.trim() || null,
                });
                await load();
            } catch (reason) {
                setError(
                    reason instanceof Error
                        ? reason.message
                        : "Failed to save review",
                );
            } finally {
                setSaving(false);
            }
        },
        [load, note, runId, saving, selected],
    );

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target;
            if (
                target instanceof Element &&
                target.matches(
                    "input, textarea, select, [contenteditable='true']",
                )
            ) {
                return;
            }
            if (event.key === "ArrowDown") {
                event.preventDefault();
                move(1);
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                move(-1);
            } else {
                const verdict = VERDICTS.find(
                    (candidate) =>
                        candidate.key.toLowerCase() ===
                        event.key.toLowerCase(),
                );
                if (verdict) {
                    event.preventDefault();
                    void saveVerdict(verdict.value);
                }
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [move, saveVerdict]);

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">
                Loading Authority Trace…
            </div>
        );
    }
    if (error && !workspace) {
        return (
            <div className="p-5 text-sm text-red-700" role="alert">
                {error}
            </div>
        );
    }
    if (!workspace || !selected) {
        return (
            <div className="p-5 text-sm text-slate-500">
                This run contains no citations.
            </div>
        );
    }

    return (
        <div className="flex h-full min-h-0 flex-col bg-slate-50">
            <div className="border-b border-slate-200 bg-white px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                    <div>
                        <h2 className="text-sm font-semibold text-slate-900">
                            Authority Trace
                        </h2>
                        <p className="text-xs text-slate-500">
                            Textual presence only—not validity or legal support
                        </p>
                    </div>
                    <span
                        className="text-xs tabular-nums text-slate-500"
                        aria-label={`${selectedIndex + 1} of ${citations.length} citations`}
                    >
                        {selectedIndex + 1} / {citations.length}
                    </span>
                </div>
                {error ? (
                    <p className="mt-2 text-xs text-red-700" role="alert">
                        {error}
                    </p>
                ) : null}
                {!workspace.integrity.ok ? (
                    <div
                        className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800"
                        role="alert"
                    >
                        <p className="font-semibold">
                            Integrity check failed
                        </p>
                        <ul className="mt-1 list-disc pl-4">
                            {workspace.integrity.warnings.map(
                                (warning, index) => (
                                    <li key={`${warning.scope}-${warning.source ?? "memo"}-${index}`}>
                                        {warning.message}
                                    </li>
                                ),
                            )}
                        </ul>
                    </div>
                ) : null}
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-[minmax(190px,0.7fr)_minmax(0,2.3fr)]">
                <aside className="min-h-0 overflow-y-auto border-r border-slate-200 bg-white p-2">
                    {citations.map((citation, index) => {
                        const state = citationState(citation);
                        const review = workspace.current_reviews[citation.id];
                        return (
                            <button
                                key={citation.id}
                                type="button"
                                onClick={() => setSelectedIndex(index)}
                                className={cn(
                                    "mb-1 w-full rounded-lg border p-2 text-left",
                                    index === selectedIndex
                                        ? "border-blue-300 bg-blue-50"
                                        : "border-transparent hover:bg-slate-50",
                                )}
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <span className="truncate text-xs font-medium text-slate-900">
                                        {citation.cite_text}
                                    </span>
                                    <span
                                        className={cn(
                                            "shrink-0 rounded px-1.5 py-0.5 text-[10px]",
                                            state.className,
                                        )}
                                    >
                                        {state.label}
                                    </span>
                                </div>
                                <p className="mt-1 line-clamp-2 text-[11px] text-slate-500">
                                    {citation.proposition}
                                </p>
                                {review ? (
                                    <p className="mt-1 text-[10px] font-medium text-blue-700">
                                        Reviewed:{" "}
                                        {review.verdict.replaceAll("_", " ")}
                                    </p>
                                ) : null}
                            </button>
                        );
                    })}
                </aside>

                <main className="flex min-h-0 flex-col">
                    <div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-slate-200">
                        <section className="min-h-0 overflow-y-auto p-4">
                            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                                Memo · {workspace.memo.filename}
                            </h3>
                            {workspace.memo.available ? (
                                <SegmentedText
                                    segments={workspace.memo.segments}
                                    citationId={selected.id}
                                />
                            ) : (
                                <p className="text-sm text-red-700">
                                    Memo version unavailable
                                </p>
                            )}
                        </section>
                        <section className="min-h-0 overflow-y-auto p-4">
                            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                                Source ·{" "}
                                {selectedSource?.title ?? "Unavailable"}
                            </h3>
                            {selectedSource?.available ? (
                                <SegmentedText
                                    segments={selectedSource.segments}
                                    citationId={selected.id}
                                />
                            ) : (
                                <p className="text-sm text-red-700">
                                    Source version unavailable
                                </p>
                            )}
                        </section>
                    </div>

                    <div className="border-t border-slate-200 bg-white p-3">
                        <label className="block text-xs font-medium text-slate-700">
                            Review note
                            <textarea
                                value={note}
                                onChange={(event) =>
                                    setNote(event.target.value)
                                }
                                maxLength={5000}
                                rows={2}
                                className="mt-1 w-full resize-none rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-400"
                            />
                        </label>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                            {VERDICTS.map((verdict) => (
                                <button
                                    key={verdict.value}
                                    type="button"
                                    disabled={saving}
                                    onClick={() =>
                                        void saveVerdict(verdict.value)
                                    }
                                    className={cn(
                                        "rounded-md border px-2.5 py-1.5 text-xs font-medium disabled:opacity-50",
                                        currentReview?.verdict === verdict.value
                                            ? "border-blue-500 bg-blue-50 text-blue-800"
                                            : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
                                    )}
                                >
                                    {verdict.label} ({verdict.key})
                                </button>
                            ))}
                            {currentReview ? (
                                <span className="ml-auto text-[11px] text-slate-500">
                                    {currentReview.reviewer_email ??
                                        currentReview.reviewer_user_id}
                                </span>
                            ) : null}
                        </div>
                        {staleReviews.length > 0 ? (
                            <details className="mt-2 text-[11px] text-slate-500">
                                <summary className="cursor-pointer">
                                    {staleReviews.length} stale{" "}
                                    {staleReviews.length === 1
                                        ? "review"
                                        : "reviews"}
                                </summary>
                                <ul className="mt-1 space-y-1 border-l border-slate-200 pl-2">
                                    {staleReviews.map((review) => (
                                        <li key={review.id}>
                                            {review.verdict.replaceAll(
                                                "_",
                                                " ",
                                            )}
                                            {review.note
                                                ? ` — ${review.note}`
                                                : ""}
                                        </li>
                                    ))}
                                </ul>
                            </details>
                        ) : null}
                    </div>
                </main>
            </div>
        </div>
    );
}
