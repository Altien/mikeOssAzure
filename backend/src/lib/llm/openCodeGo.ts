import { resolveProviderSecret } from "../envSecrets";
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

async function apiKey(override?: string | null): Promise<string> {
  const key = override?.trim() || (await resolveProviderSecret("opencode-api-key")) || "";
  if (!key) {
    throw new Error(
      "OpenCode Go API key is not configured. Set OPENCODE_API_KEY or configure the organisation Key Vault credential.",
    );
  }
  return key;
}

async function messagesConfig(
  model: string,
  apiKeys?: UserApiKeys,
): Promise<AnthropicMessagesAdapterConfig> {
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
    apiKey: await apiKey(apiKeys?.["opencode-go"]),
    baseURL,
    // OpenCode's Qwen and MiniMax models use Anthropic's wire format, but do
    // not implement Claude's adaptive-thinking request fields.
    adaptiveThinking: false,
  };
}

function unsupportedModel(model: string): Error {
  return new Error(
    `OpenCode Go model ${openCodeGoModelId(model)} requires a protocol Mike does not support yet. Select a model listed in Settings → Bring Your Own Keys → Routers.`,
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
      await messagesConfig(params.model, params.apiKeys),
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
      await messagesConfig(params.model, params.apiKeys),
    );
  }
  throw unsupportedModel(params.model);
}
