import type { ToolCall } from "../../modules/chat/chat.service";
import { findTextMatches } from "../../modules/chat/chat.service";
import {
  registerVerificationArtifact,
  type VerificationArtifactStore,
} from "../authorityTrace/core/service";
import {
  ExternalSourceCache,
  type CachedExternalSource,
} from "./cache";
import { EXTERNAL_SOURCE_TOOL_NAMES } from "./toolDefinitions";

type ToolResult = {
  role: "tool";
  tool_call_id: string;
  content: string;
};

export function registerExternalSourceArtifact(
  store: VerificationArtifactStore,
  cached: CachedExternalSource,
): string {
  return registerVerificationArtifact(store, {
    artifactId: cached.cacheRecordId ?? cached.source.id,
    provider: cached.source.provider,
    externalId: cached.source.externalId,
    versionId: cached.source.versionId,
    filename: `${cached.source.title}.txt`,
    text: cached.source.text,
    originUrl: cached.source.originUrl,
  });
}

export async function dispatchExternalSourceTool(input: {
  toolCall: ToolCall;
  args: Record<string, unknown>;
  externalSources: ExternalSourceCache;
  verificationArtifacts: VerificationArtifactStore;
  toolResults: unknown[];
}): Promise<boolean> {
  const { toolCall, args, externalSources, verificationArtifacts, toolResults } =
    input;
  if (
    toolCall.function.name !== EXTERNAL_SOURCE_TOOL_NAMES.search &&
    toolCall.function.name !== EXTERNAL_SOURCE_TOOL_NAMES.read
  ) {
    return false;
  }

  const sourceId =
    typeof args.external_source_id === "string"
      ? args.external_source_id
      : "";
  const cached = await externalSources.resolve(sourceId);
  if (!cached) {
    toolResults.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify({
        ok: false,
        external_source_id: sourceId,
        error:
          "External source is unavailable or unauthorized. Call its retrieval or download tool first.",
      }),
    } satisfies ToolResult);
    return true;
  }

  const verificationSourceId = registerExternalSourceArtifact(
    verificationArtifacts,
    cached,
  );
  if (toolCall.function.name === EXTERNAL_SOURCE_TOOL_NAMES.search) {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    const maxResults =
      typeof args.max_results === "number"
        ? Math.max(1, Math.min(50, Math.floor(args.max_results)))
        : 20;
    const contextChars =
      typeof args.context_chars === "number"
        ? Math.max(40, Math.min(2_000, Math.floor(args.context_chars)))
        : 240;
    const matches = findTextMatches({
      text: cached.source.text,
      query,
      maxResults,
      contextChars,
    });
    toolResults.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify({
        ok: true,
        external_source_id: sourceId,
        verification_source_id: verificationSourceId,
        title: cached.source.title,
        query,
        total_matches: matches.totalMatches,
        returned: matches.hits.length,
        truncated: matches.totalMatches > matches.hits.length,
        hits: matches.hits,
      }),
    } satisfies ToolResult);
    return true;
  }

  const start =
    typeof args.start === "number"
      ? Math.max(
          0,
          Math.min(cached.source.text.length, Math.floor(args.start)),
        )
      : 0;
  const maxChars =
    typeof args.max_chars === "number"
      ? Math.max(500, Math.min(50_000, Math.floor(args.max_chars)))
      : 12_000;
  const end = Math.min(cached.source.text.length, start + maxChars);
  toolResults.push({
    role: "tool",
    tool_call_id: toolCall.id,
    content: JSON.stringify({
      ok: true,
      external_source_id: sourceId,
      verification_source_id: verificationSourceId,
      title: cached.source.title,
      start,
      end,
      total_chars: cached.source.text.length,
      truncated: end < cached.source.text.length,
      text: cached.source.text.slice(start, end),
    }),
  } satisfies ToolResult);
  return true;
}
