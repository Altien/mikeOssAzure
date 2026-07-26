import type { AssistantEvent } from "@/app/components/shared/types";

export type AuthorityTraceAssistantEvent =
  | {
      type: "authority_trace_extraction";
      outcome?: "success" | "fatal";
      document_id?: string;
      version_id?: string;
      document_handle?: string;
      filename?: string;
      page_count?: number | null;
      warnings?: string[];
      error?: string;
      isStreaming?: boolean;
    }
  | {
      type: "authority_trace_verification";
      run_id?: string;
      outcome?:
        | "success"
        | "completed_with_failures"
        | "action_required"
        | "fatal";
      total: number;
      anchored: number;
      failed: number;
      exact?: number;
      formatting_different?: number;
      no_quote_claimed?: number;
      warning_count?: number;
      diagnostics?: string[];
      error?: string;
      isStreaming?: boolean;
    };

export function handleAuthorityTraceStreamEvent(input: {
  data: Record<string, unknown>;
  pushEvent: (event: AssistantEvent) => void;
  updateMatchingEvent: (
    predicate: (event: AssistantEvent) => boolean,
    updater: (event: AssistantEvent) => AssistantEvent,
  ) => boolean;
  pushThinkingPlaceholder: () => void;
}): boolean {
  const { data, pushEvent, updateMatchingEvent, pushThinkingPlaceholder } =
    input;

  if (data.type === "authority_trace_extraction_start") {
    pushEvent({
      type: "authority_trace_extraction",
      isStreaming: true,
    });
    return true;
  }

  if (data.type === "authority_trace_extraction") {
    updateMatchingEvent(
      (event) =>
        event.type === "authority_trace_extraction" && !!event.isStreaming,
      () => ({
        type: "authority_trace_extraction",
        outcome: data.outcome === "success" ? "success" : "fatal",
        document_id:
          typeof data.document_id === "string" ? data.document_id : undefined,
        version_id:
          typeof data.version_id === "string" ? data.version_id : undefined,
        document_handle:
          typeof data.document_handle === "string"
            ? data.document_handle
            : undefined,
        filename: typeof data.filename === "string" ? data.filename : undefined,
        page_count:
          typeof data.page_count === "number" || data.page_count === null
            ? data.page_count
            : undefined,
        warnings: Array.isArray(data.warnings)
          ? data.warnings.filter(
              (value: unknown): value is string => typeof value === "string",
            )
          : undefined,
        error: typeof data.error === "string" ? data.error : undefined,
        isStreaming: false,
      }),
    );
    pushThinkingPlaceholder();
    return true;
  }

  if (data.type === "authority_trace_verification_start") {
    pushEvent({
      type: "authority_trace_verification",
      total: typeof data.citation_count === "number" ? data.citation_count : 0,
      anchored: 0,
      failed: 0,
      isStreaming: true,
    });
    return true;
  }

  if (data.type !== "authority_trace_verification") {
    return false;
  }

  updateMatchingEvent(
    (event) =>
      event.type === "authority_trace_verification" && !!event.isStreaming,
    () => ({
      type: "authority_trace_verification",
      run_id: typeof data.run_id === "string" ? data.run_id : undefined,
      outcome:
        data.outcome === "success" ||
        data.outcome === "completed_with_failures" ||
        data.outcome === "action_required" ||
        data.outcome === "fatal"
          ? data.outcome
          : "fatal",
      total: typeof data.total === "number" ? data.total : 0,
      anchored: typeof data.anchored === "number" ? data.anchored : 0,
      failed: typeof data.failed === "number" ? data.failed : 0,
      exact: typeof data.exact === "number" ? data.exact : undefined,
      formatting_different:
        typeof data.formatting_different === "number"
          ? data.formatting_different
          : undefined,
      no_quote_claimed:
        typeof data.no_quote_claimed === "number"
          ? data.no_quote_claimed
          : undefined,
      warning_count:
        typeof data.warning_count === "number"
          ? data.warning_count
          : undefined,
      diagnostics: Array.isArray(data.diagnostics)
        ? data.diagnostics.filter(
            (value: unknown): value is string => typeof value === "string",
          )
        : undefined,
      error: typeof data.error === "string" ? data.error : undefined,
      isStreaming: false,
    }),
  );
  pushThinkingPlaceholder();
  return true;
}
