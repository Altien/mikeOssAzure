import {
  completeAnthropicMessagesText,
  streamAnthropicMessages,
  type AnthropicMessagesAdapterConfig,
} from "./claude";
import {
  isOpenCodeGoChatCompletionsModel,
  isOpenCodeGoMessagesModel,
  openCodeGoModelId,
} from "./models";
import { completeOpenRouterText, streamOpenRouter } from "./openrouter";
import type {
  StreamChatParams,
  StreamChatResult,
  UserApiKeys,
} from "./types";

function apiKey(override?: string | null): string {
  const key = override?.trim() || process.env.OPENCODE_API_KEY?.trim() || "";
  if (!key) {
    throw new Error(
      "OpenCode Go API key is not configured. Set OPENCODE_API_KEY or add a user OpenCode Go key.",
    );
  }
  return key;
}

function messagesConfig(
  model: string,
  apiKeys?: UserApiKeys,
): AnthropicMessagesAdapterConfig {
  const gatewayBaseURL = (
    process.env.OPENCODE_GO_BASE_URL?.trim() ||
    "https://opencode.ai/zen/go/v1"
  ).replace(/\/+$/, "");
  // Anthropic's SDK appends /v1/messages itself, while the shared gateway
  // setting is an OpenAI-style base URL that already ends in /v1.
  const baseURL = gatewayBaseURL.replace(/\/v1$/, "");
  return {
    provider: "opencode-go",
    label: "OpenCode Go",
    model: openCodeGoModelId(model),
    apiKey: apiKey(apiKeys?.["opencode-go"]),
    baseURL,
    // OpenCode's Qwen and MiniMax models use Anthropic's wire format, but do
    // not implement Claude's adaptive-thinking request fields.
    adaptiveThinking: false,
  };
}

function unsupportedModel(model: string): Error {
  return new Error(
    `OpenCode Go model ${openCodeGoModelId(model)} requires a protocol Mike does not support yet. Select a model listed in Settings → BYOK → Routers.`,
  );
}

export async function streamOpenCodeGo(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  if (isOpenCodeGoChatCompletionsModel(params.model)) {
    return streamOpenRouter(params);
  }
  if (isOpenCodeGoMessagesModel(params.model)) {
    return streamAnthropicMessages(
      params,
      messagesConfig(params.model, params.apiKeys),
    );
  }
  throw unsupportedModel(params.model);
}

export async function completeOpenCodeGoText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: UserApiKeys;
}): Promise<string> {
  if (isOpenCodeGoChatCompletionsModel(params.model)) {
    return completeOpenRouterText(params);
  }
  if (isOpenCodeGoMessagesModel(params.model)) {
    return completeAnthropicMessagesText(
      params,
      messagesConfig(params.model, params.apiKeys),
    );
  }
  throw unsupportedModel(params.model);
}
