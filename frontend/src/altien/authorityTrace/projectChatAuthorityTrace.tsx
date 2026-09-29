"use client";

/**
 * Authority Trace tab for upstream's project chat page (dev-only, OSS-6
 * §2.3 item 7).
 *
 * The project chat page (`projects/[id]/assistant/chat/[chatId]/page.tsx`)
 * has its own document tab strip keyed by document id. The Authority Trace
 * tab lives beside those tabs under the id `authority-trace:<runId>`, so
 * upstream's `activeTab` lookup (by document id) naturally resolves to null
 * while the trace is showing. The page hooks this in with one hook call,
 * the tab item after its tab map, one branch in the viewer body, and
 * `onAuthorityTraceOpen` on AssistantMessage.
 */

import { useCallback, useState, type MutableRefObject } from "react";
import { FileText, X } from "lucide-react";

export type ProjectChatAuthorityTrace = {
    runId: string | null;
    tabId: string | null;
    active: boolean;
    open: (runId: string) => void;
    close: () => void;
    activate: () => void;
};

export function useProjectChatAuthorityTrace({
    activeTabId,
    setActiveTabId,
    onOpen,
    onClose,
}: {
    activeTabId: string | null;
    setActiveTabId: (id: string | null) => void;
    /** Clears the page's document-specific view state (quotes, selection). */
    onOpen: () => void;
    /** Moves the page back to a document tab (or none) after closing. */
    onClose: () => void;
}): ProjectChatAuthorityTrace {
    const [runId, setRunId] = useState<string | null>(null);
    const tabId = runId ? `authority-trace:${runId}` : null;
    const active = tabId !== null && activeTabId === tabId;

    const open = useCallback(
        (nextRunId: string) => {
            setRunId(nextRunId);
            setActiveTabId(`authority-trace:${nextRunId}`);
            onOpen();
        },
        [setActiveTabId, onOpen],
    );

    const close = useCallback(() => {
        setRunId(null);
        onClose();
    }, [onClose]);

    const activate = useCallback(() => {
        if (tabId) setActiveTabId(tabId);
    }, [tabId, setActiveTabId]);

    return { runId, tabId, active, open, close, activate };
}

/** The tab-strip item, styled like upstream's document tabs. */
export function AuthorityTraceTabItem({
    trace,
    tabItemRefs,
}: {
    trace: ProjectChatAuthorityTrace;
    tabItemRefs: MutableRefObject<Record<string, HTMLDivElement | null>>;
}) {
    const { runId, tabId, active } = trace;
    if (!runId || !tabId) return null;
    return (
        <div
            ref={(el) => {
                tabItemRefs.current[tabId] = el;
            }}
            onClick={trace.activate}
            className={`group flex h-full max-w-[260px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-gray-200 px-3 transition-colors ${
                active ? "bg-gray-100" : "bg-white hover:bg-gray-50"
            }`}
        >
            <FileText className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
            <span
                className={`truncate text-xs ${
                    active ? "font-medium text-gray-900" : "text-gray-500"
                }`}
            >
                Authority Trace
            </span>
            <button
                type="button"
                aria-label="Close Authority Trace"
                onClick={(event) => {
                    event.stopPropagation();
                    trace.close();
                }}
                className={`shrink-0 transition-colors ${
                    active
                        ? "text-gray-500 hover:text-gray-700"
                        : "text-gray-300 hover:text-gray-600"
                }`}
            >
                <X className="h-3 w-3" />
            </button>
        </div>
    );
}
