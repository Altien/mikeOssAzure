"use client";

import { ChevronRight } from "lucide-react";
import type { AuthorityTraceAssistantEvent } from "./events";

export function AuthorityTraceEventBlock({
  event,
  showConnector,
  onOpen,
}: {
  event: AuthorityTraceAssistantEvent;
  showConnector?: boolean;
  onOpen?: (runId: string) => void;
}) {
  const isExtraction = event.type === "authority_trace_extraction";
  const label = isExtraction
    ? event.isStreaming
      ? "Extracting verification document"
      : event.outcome === "fatal"
        ? "Verification extraction failed"
        : "Verification document extracted"
    : event.isStreaming
      ? "Verifying citation sources"
      : event.outcome === "fatal"
        ? "Authority Trace failed"
        : event.outcome === "action_required"
          ? "Authority Trace needs document extraction"
          : event.outcome === "completed_with_failures"
            ? "Authority Trace completed with failures"
            : "Authority Trace completed";
  const detail = isExtraction
    ? event.isStreaming
      ? undefined
      : event.error
        ? event.error
        : [
            event.filename,
            event.document_handle,
            ...(event.warnings ?? []).map((warning) =>
              warning.replaceAll("_", " "),
            ),
          ]
            .filter(Boolean)
            .join(" · ")
    : event.isStreaming
      ? `${event.total} ${event.total === 1 ? "citation" : "citations"}`
      : event.error
        ? event.error
        : [
            `${event.exact ?? event.anchored} exact`,
            event.formatting_different
              ? `${event.formatting_different} formatting differs`
              : null,
            `${event.failed} failed`,
            event.no_quote_claimed
              ? `${event.no_quote_claimed} no quote`
              : null,
            event.warning_count ? `${event.warning_count} warnings` : null,
            ...(event.diagnostics ?? []),
          ]
            .filter(Boolean)
            .join(" · ");
  const hasError = isExtraction
    ? event.outcome === "fatal" ||
      (event.warnings?.includes("ocr_required") ?? false)
    : event.outcome === "fatal" || event.failed > 0;
  const canOpen =
    !isExtraction &&
    !event.isStreaming &&
    event.outcome !== "fatal" &&
    !!event.run_id &&
    !!onOpen;

  return (
    <div className="relative">
      {showConnector && (
        <div className="absolute bottom-0 w-[1px] bg-gray-300 top-[13px] left-[2.5px] h-[calc(100%+11px)]" />
      )}
      <div className="flex items-start text-sm font-serif text-gray-500">
        {event.isStreaming ? (
          <div className="mt-2 w-1.5 h-1.5 rounded-full border border-gray-400 border-t-transparent animate-spin shrink-0" />
        ) : (
          <div
            className={`mt-2 w-1.5 h-1.5 rounded-full shrink-0 ${hasError ? "bg-red-500" : "bg-green-400"}`}
          />
        )}
        <div className="ml-2 min-w-0 flex-1 whitespace-normal break-words">
          {canOpen ? (
            <button
              type="button"
              onClick={() => onOpen(event.run_id!)}
              className="group flex w-full cursor-pointer items-center gap-2 rounded-md border border-emerald-200/70 bg-emerald-50/50 px-2 py-1.5 text-left text-gray-600 transition-colors hover:bg-emerald-50 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
            >
              <span className="min-w-0 flex-1">
                <span className="font-medium">{label}</span>
                {detail ? <span> {detail}</span> : null}
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-emerald-700 group-hover:text-emerald-800">
                Open review
                <ChevronRight size={13} aria-hidden="true" />
              </span>
            </button>
          ) : (
            <>
              <span className="font-medium">{label}</span>
              {detail ? <span> {detail}</span> : null}
              {event.isStreaming ? <span>...</span> : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
