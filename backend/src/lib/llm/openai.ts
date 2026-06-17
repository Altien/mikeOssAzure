// OpenAI-direct dispatcher. OpenAI exposes two wire protocols and dev supports
// both:
//   - Chat Completions (./openai_c.ts) — the portable standard (the same shape
//     Azure OpenAI / OpenRouter / OpenAI-compatible endpoints speak). DEFAULT.
//   - Responses API (./openai_r.ts) — OpenAI-direct only; unlocks reasoning
//     summaries + server-side response chaining. Opt-in.
//
// Selection: set OPENAI_API_MODE=responses to use the Responses adapter;
// anything else (unset/"completions") keeps the Completions adapter, preserving
// existing behaviour. The flag is a deployment mode, not a secret, so it's a
// plain env var. Do NOT enable responses mode when pointing the OpenAI provider
// at a non-OpenAI base URL (OpenRouter / compatible) — those speak Completions.
//
// index.ts imports streamOpenAI / completeOpenAIText from here; the two adapter
// files are never imported directly elsewhere.
import {
  streamOpenAI as streamOpenAICompletions,
  completeOpenAIText as completeOpenAICompletionsText,
} from "./openai_c";
import {
  streamOpenAI as streamOpenAIResponses,
  completeOpenAIText as completeOpenAIResponsesText,
} from "./openai_r";
import type { StreamChatParams, StreamChatResult, NormalizedToolResult } from "./types";

function useResponsesApi(): boolean {
  return (process.env.OPENAI_API_MODE ?? "").trim().toLowerCase() === "responses";
}

export function streamOpenAI(params: StreamChatParams): Promise<StreamChatResult> {
  return useResponsesApi()
    ? streamOpenAIResponses(params)
    : streamOpenAICompletions(params);
}

export function completeOpenAIText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: { openai?: string | null };
}): Promise<string> {
  return useResponsesApi()
    ? completeOpenAIResponsesText(params)
    : completeOpenAICompletionsText(params);
}

export type { NormalizedToolResult };
