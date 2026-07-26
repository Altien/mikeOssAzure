import type { createServerSupabase } from "../../lib/supabase";
import type { DocIndex, ToolCall } from "../../lib/chat/types";
import {
  ExternalSourceCache,
} from "../externalSources/cache";
import { registerExternalSourceArtifact } from "../externalSources/chatDispatcher";
import { extractDocumentForVerification } from "./core/extractionService";
import {
  VerificationExtractionRequiredError,
  verifyCitationSources,
  type VerificationArtifactStore,
} from "./core/service";
import {
  AUTHORITY_TRACE_TOOL_NAMES,
  type AuthorityTraceEvent,
} from "./chatTools";

export type AuthorityTraceTurnState = {
  verificationAttempts: number;
  terminal: boolean;
  fatal: boolean;
};

type ToolResult = {
  role: "tool";
  tool_call_id: string;
  content: string;
};

export async function dispatchAuthorityTraceTool(input: {
  toolCall: ToolCall;
  args: Record<string, unknown>;
  userId: string;
  projectId?: string | null;
  docIndex?: DocIndex;
  db: ReturnType<typeof createServerSupabase>;
  write: (value: string) => void;
  verificationArtifacts: VerificationArtifactStore;
  externalSources: ExternalSourceCache;
  authorityTraceState?: AuthorityTraceTurnState;
  authorityTraceEvents: AuthorityTraceEvent[];
  toolResults: unknown[];
}): Promise<boolean> {
  const {
    toolCall,
    args,
    userId,
    projectId,
    docIndex,
    db,
    write,
    verificationArtifacts,
    externalSources,
    authorityTraceState,
    authorityTraceEvents,
    toolResults,
  } = input;

  if (
    toolCall.function.name === AUTHORITY_TRACE_TOOL_NAMES.readVerificationSource
  ) {
    const artifactId =
      typeof args.verification_source_id === "string"
        ? args.verification_source_id
        : "";
    let artifact = verificationArtifacts.get(artifactId);
    if (!artifact) {
      const cached = await externalSources.resolve(artifactId);
      if (cached) {
        registerExternalSourceArtifact(verificationArtifacts, cached);
        artifact = verificationArtifacts.get(
          cached.cacheRecordId ?? cached.source.id,
        );
      }
    }
    toolResults.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content: artifact
        ? JSON.stringify({
            ok: true,
            verification_source_id: artifact.artifactId,
            provider: artifact.provider,
            version_id: artifact.versionId,
            filename: artifact.filename,
            origin_url: artifact.originUrl,
            text: artifact.text,
          })
        : JSON.stringify({
            ok: false,
            error: "Verification source is unavailable or unauthorized.",
          }),
    } satisfies ToolResult);
    return true;
  }

  if (toolCall.function.name === AUTHORITY_TRACE_TOOL_NAMES.extractDocument) {
    write(
      `data: ${JSON.stringify({
        type: "authority_trace_extraction_start",
        document_id:
          typeof args.document_id === "string"
            ? args.document_id
            : undefined,
      })}\n\n`,
    );
    try {
      if (!projectId || !docIndex) {
        throw new Error(
          "Document extraction requires an active project context",
        );
      }
      if (typeof args.document_id !== "string") {
        throw new Error("document_id is required");
      }
      const result = await extractDocumentForVerification(
        {
          projectId,
          userId,
          documentId: args.document_id,
          ...(typeof args.version_id === "string"
            ? { versionId: args.version_id }
            : {}),
          ...(typeof args.first_page === "number"
            ? { firstPage: args.first_page }
            : {}),
          docIndex,
        },
        db,
      );
      let nextIndex = Object.keys(docIndex).length;
      let documentHandle = `doc-${nextIndex}`;
      while (Object.hasOwn(docIndex, documentHandle)) {
        nextIndex += 1;
        documentHandle = `doc-${nextIndex}`;
      }
      docIndex[documentHandle] = {
        document_id: result.extracted_document_id,
        filename: result.filename,
      };
      const event: AuthorityTraceEvent = {
        type: "authority_trace_extraction",
        outcome: "success",
        document_id: result.extracted_document_id,
        version_id: result.extracted_version_id,
        document_handle: documentHandle,
        filename: result.filename,
        page_count: result.page_count,
        warnings: result.warnings,
      };
      authorityTraceEvents.push(event);
      write(`data: ${JSON.stringify(event)}\n\n`);
      toolResults.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify({
          ...result,
          document_handle: documentHandle,
        }),
      } satisfies ToolResult);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Document extraction failed";
      const event: AuthorityTraceEvent = {
        type: "authority_trace_extraction",
        outcome: "fatal",
        error: message,
      };
      authorityTraceEvents.push(event);
      write(`data: ${JSON.stringify(event)}\n\n`);
      toolResults.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify({ outcome: "fatal", error: message }),
      } satisfies ToolResult);
    }
    return true;
  }

  if (
    toolCall.function.name !== AUTHORITY_TRACE_TOOL_NAMES.verifyCitationSources
  ) {
    return false;
  }

  const traceState =
    authorityTraceState ??
    ({
      verificationAttempts: 0,
      terminal: false,
      fatal: false,
    } satisfies AuthorityTraceTurnState);
  const citationCount = Array.isArray(args.citations)
    ? args.citations.length
    : 0;
  if (traceState.terminal || traceState.verificationAttempts >= 3) {
    toolResults.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify({
        outcome: traceState.terminal
          ? "already_completed"
          : "retry_limit_reached",
        retries_remaining: 0,
        instruction: traceState.terminal
          ? "Do not call verify_citation_sources again; summarize the completed run."
          : "Do not call verify_citation_sources again; summarize every residual failure and warning.",
      }),
    } satisfies ToolResult);
    return true;
  }

  write(
    `data: ${JSON.stringify({
      type: "authority_trace_verification_start",
      citation_count: citationCount,
    })}\n\n`,
  );
  try {
    if (traceState.fatal) {
      throw new Error(
        "Authority Trace stopped after a fatal error in this assistant turn",
      );
    }
    if (!projectId || !docIndex) {
      throw new Error(
        "Citation verification requires an active project context",
      );
    }
    traceState.verificationAttempts += 1;
    const result = await verifyCitationSources(
      {
        projectId,
        userId,
        proposal: args,
        docIndex,
        sourceArtifacts: verificationArtifacts,
      },
      db,
    );
    if (result.report.outcome === "success") {
      traceState.terminal = true;
    }
    const retriesRemaining = Math.max(
      0,
      3 - traceState.verificationAttempts,
    );
    const event: AuthorityTraceEvent = {
      type: "authority_trace_verification",
      run_id: result.runId,
      outcome: result.report.outcome,
      total: result.report.total,
      anchored: result.report.anchored,
      failed: result.report.failed,
      exact: result.report.exact,
      formatting_different: result.report.formatting_different,
      no_quote_claimed: result.report.no_quote_claimed,
      warning_count: result.report.warnings?.length ?? 0,
      diagnostics: [
        ...result.report.failures.map(
          (failure) =>
            `${failure.citation_id}: ${failure.reason.replaceAll("_", " ")}`,
        ),
        ...(result.report.warnings ?? []).map(
          (warning) =>
            `${warning.citation_id}: ${warning.warning.replaceAll("_", " ")}`,
        ),
      ],
    };
    authorityTraceEvents.push(event);
    write(`data: ${JSON.stringify(event)}\n\n`);
    toolResults.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify({
        run_id: result.runId,
        ...result.report,
        retries_remaining: retriesRemaining,
        instruction:
          result.report.outcome === "completed_with_failures" &&
          retriesRemaining === 0
            ? "Retry limit reached. Summarize every residual failure and warning."
            : undefined,
      }),
    } satisfies ToolResult);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Citation verification failed";
    if (error instanceof VerificationExtractionRequiredError) {
      traceState.verificationAttempts = Math.max(
        0,
        traceState.verificationAttempts - 1,
      );
      const event: AuthorityTraceEvent = {
        type: "authority_trace_verification",
        outcome: "action_required",
        total: 0,
        anchored: 0,
        failed: 0,
        error: message,
      };
      authorityTraceEvents.push(event);
      write(`data: ${JSON.stringify(event)}\n\n`);
      toolResults.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify({
          outcome: "action_required",
          error: message,
          retries_remaining: Math.max(
            0,
            3 - traceState.verificationAttempts,
          ),
          instruction:
            "Call extract_document_for_verification for this document, replace its handle in the proposal, then retry verify_citation_sources.",
        }),
      } satisfies ToolResult);
      return true;
    }
    traceState.fatal = true;
    const event: AuthorityTraceEvent = {
      type: "authority_trace_verification",
      outcome: "fatal",
      total: 0,
      anchored: 0,
      failed: 0,
      error: message,
    };
    authorityTraceEvents.push(event);
    write(`data: ${JSON.stringify(event)}\n\n`);
    toolResults.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify({ outcome: "fatal", error: message }),
    } satisfies ToolResult);
  }
  return true;
}
