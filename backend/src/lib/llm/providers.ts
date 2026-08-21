import {
  aiSdkFetch,
  completeAiSdkText,
  streamAiSdk,
  type AiSdkAdapterConfig,
} from "./aiSdk";
import {
  isOpenCodeGoChatCompletionsModel,
  isOpenCodeGoMessagesModel,
  openCodeGoModelId,
  openRouterModelId,
  providerForModel,
  vercelModelId,
} from "./models";
import type {
  Provider,
  StreamChatParams,
  StreamChatResult,
  UserApiKeys,
} from "./types";
import { resolveSecret, resolveProviderSecret } from "../envSecrets";
import { resolveVercelApiKey } from "../userApiKeys";

const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL?.trim().replace(/\/+$/, "") ||
  "https://openrouter.ai/api/v1";
const OPENCODE_GO_BASE_URL =
  process.env.OPENCODE_GO_BASE_URL?.trim().replace(/\/+$/, "") ||
  "https://opencode.ai/zen/go/v1";
const VERCEL_GATEWAY_BASE_URL =
  process.env.VERCEL_AI_GATEWAY_BASE_URL?.trim().replace(/\/+$/, "");

type CompleteProviderParams = {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: UserApiKeys;
  reasoningEffort?: "none" | "low" | "high" | "max";
};

type RouterProvider = Extract<
  Provider,
  "openrouter" | "vercel" | "opencode-go"
>;

const ROUTER_LABELS: Record<RouterProvider, string> = {
  openrouter: "OpenRouter",
  vercel: "Vercel AI Gateway",
  "opencode-go": "OpenCode Go",
};

async function requiredKey(label: string, secretName: string, override?: string | null): Promise<string> {
  const key = override?.trim() || await resolveSecret(secretName);
  if (!key) throw new Error(`${label} is not configured for this organisation. Ask an administrator to set the ${secretName} Key Vault secret in /install.`);
  return key;
}

function routerUserKey(
  provider: RouterProvider,
  apiKeys?: UserApiKeys,
): string | null | undefined {
  if (provider === "vercel") return apiKeys?.vercel;
  if (provider === "opencode-go") return apiKeys?.["opencode-go"];
  return apiKeys?.openrouter;
}

async function routerKey(provider: RouterProvider, apiKeys?: UserApiKeys): Promise<string> {
  const key = routerUserKey(provider, apiKeys)?.trim() ||
    (provider === "vercel" ? await resolveVercelApiKey() :
      provider === "openrouter" ? await resolveProviderSecret("openrouter-api-key") :
      await resolveProviderSecret("opencode-api-key"));
  if (!key) {
    throw new Error(
      `${ROUTER_LABELS[provider]} is not configured for this organisation. Ask an administrator to set the provider Key Vault secret in /install.`,
    );
  }
  return key;
}

async function createAnthropicAdapter(args: {
  provider: Extract<Provider, "claude" | "opencode-go">;
  label: string;
  model: string;
  apiKey: string;
  baseURL?: string;
  supportsReasoning: boolean;
}): Promise<AiSdkAdapterConfig> {
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  const anthropic = createAnthropic({
    apiKey: args.apiKey,
    baseURL: args.baseURL,
    name: `${args.provider}.messages`,
    fetch: aiSdkFetch,
  });
  return {
    provider: args.provider,
    label: args.label,
    model: anthropic(args.model),
    modelId: args.model,
    supportsReasoning: args.supportsReasoning,
  };
}

async function createRouterAdapter(
  provider: RouterProvider,
  model: string,
  apiKeys?: UserApiKeys,
): Promise<AiSdkAdapterConfig> {
  if (provider === "opencode-go" && !isOpenCodeGoChatCompletionsModel(model)) {
    throw unsupportedOpenCodeGoModel(model);
  }
  const key = await routerKey(provider, apiKeys);

  if (provider === "openrouter") {
    const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
    const openrouter = createOpenRouter({
      apiKey: key,
      baseURL: OPENROUTER_BASE_URL,
      compatibility: "strict",
      appName: "Mike",
      appUrl: process.env.FRONTEND_URL,
      fetch: aiSdkFetch,
    });
    return {
      provider,
      label: ROUTER_LABELS[provider],
      model: openrouter.chat(openRouterModelId(model)),
      modelId: model,
    };
  }

  if (provider === "vercel") {
    const { createGateway } = await import("ai");
    const gateway = createGateway({
      apiKey: key,
      ...(VERCEL_GATEWAY_BASE_URL ? { baseURL: VERCEL_GATEWAY_BASE_URL } : {}),
      fetch: aiSdkFetch,
    });
    return {
      provider,
      label: ROUTER_LABELS[provider],
      model: gateway.chat(vercelModelId(model)),
      modelId: model,
    };
  }

  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const openCodeGo = createOpenAICompatible({
    name: "opencodeGo",
    apiKey: key,
    baseURL: OPENCODE_GO_BASE_URL,
    fetch: aiSdkFetch,
  });
  return {
    provider,
    label: ROUTER_LABELS[provider],
    model: openCodeGo(openCodeGoModelId(model)),
    modelId: model,
    supportsReasoning: false,
  };
}

function unsupportedOpenCodeGoModel(model: string): Error {
  return new Error(
    `OpenCode Go model ${openCodeGoModelId(model)} requires a protocol Mike does not support yet. Select a model listed in Settings → Bring Your Own Keys → Routers.`,
  );
}

const DEFAULT_AZURE_API_VERSION = "2024-10-21";

// Azure deployment names are arbitrary and cannot be used to infer GPT family.
// Keep the existing Chat Completions token field even for an alias such as
// "production", which the generic OpenAI provider would treat as non-reasoning.
async function azureSdkFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (typeof init?.body !== "string") return aiSdkFetch(input, init);
  const body = JSON.parse(init.body) as Record<string, unknown>;
  if (body.max_tokens !== undefined) {
    body.max_completion_tokens ??= body.max_tokens;
    delete body.max_tokens;
  }
  return aiSdkFetch(input, { ...init, body: JSON.stringify(body) });
}

function azureDeployment(model: string, settings?: UserApiKeys["azureOpenai"]): string {
  const requested = model.startsWith("aoai:") ? model.slice(5).trim() : "";
  const deployment = requested && requested !== "default" ? requested :
    settings?.deployment?.trim() || process.env.AZURE_OPENAI_DEPLOYMENT?.trim();
  if (!deployment) throw new Error("Azure OpenAI deployment missing. Pick a specific deployment or configure the organisation connection through /install.");
  return deployment;
}

async function createAzureAdapter(model: string, apiKeys?: UserApiKeys): Promise<AiSdkAdapterConfig> {
  const settings = apiKeys?.azureOpenai;
  const endpoint = settings?.endpoint?.trim() || await resolveSecret("azure-openai-endpoint");
  const apiKey = settings?.apiKey?.trim() || await resolveSecret("azure-openai-api-key");
  const apiVersion = settings?.apiVersion?.trim() || process.env.AZURE_OPENAI_API_VERSION?.trim() || DEFAULT_AZURE_API_VERSION;
  if (!endpoint || !apiKey) throw new Error("Azure OpenAI is not configured for this organisation. Ask an administrator to set its endpoint and API key in /install.");
  const deployment = azureDeployment(model, settings);
  const { createAzure } = await import("@ai-sdk/azure");
  const azure = createAzure({
    baseURL: `${endpoint.replace(/\/+$/, "").replace(/\/openai$/, "")}/openai`,
    apiKey,
    apiVersion,
    useDeploymentBasedUrls: true,
    fetch: azureSdkFetch,
  });
  return { provider: "azureOpenai", label: "Azure OpenAI", model: azure.chat(deployment), modelId: model };
}

async function createProviderAdapter(
  model: string,
  apiKeys?: UserApiKeys,
): Promise<AiSdkAdapterConfig> {
  const provider = providerForModel(model);

  if (provider === "claude") {
    return createAnthropicAdapter({
      provider,
      label: "Claude",
      model,
      apiKey: await requiredKey("Anthropic", "anthropic-api-key", apiKeys?.claude),
      supportsReasoning: true,
    });
  }

  if (provider === "gemini") {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    const google = createGoogleGenerativeAI({
      apiKey: await requiredKey("Gemini", "gemini-api-key", apiKeys?.gemini),
      fetch: aiSdkFetch,
    });
    return { provider, label: "Gemini", model: google(model), modelId: model };
  }

  if (provider === "openai") {
    const { createOpenAI } = await import("@ai-sdk/openai");
    const openai = createOpenAI({
      apiKey: await requiredKey("OpenAI", "openai-api-key", apiKeys?.openai),
      baseURL: (await resolveSecret("openai-base-url")) || undefined,
      fetch: aiSdkFetch,
    });
    return {
      provider,
      label: "OpenAI",
      model: process.env.OPENAI_API_MODE?.trim().toLowerCase() === "responses" ? openai.responses(model) : openai.chat(model),
      modelId: model,
      courtlistenerCitationReminder: true,
    };
  }

  if (provider === "openrouter" || provider === "vercel") {
    return createRouterAdapter(provider, model, apiKeys);
  }

  if (provider === "opencode-go") {
    if (isOpenCodeGoMessagesModel(model)) {
      return createAnthropicAdapter({
        provider,
        label: "OpenCode Go",
        model: openCodeGoModelId(model),
        apiKey: await routerKey(provider, apiKeys),
        baseURL: OPENCODE_GO_BASE_URL,
        supportsReasoning: false,
      });
    }
    return createRouterAdapter(provider, model, apiKeys);
  }

  if (provider === "kimi") {
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
    const kimi = createOpenAICompatible({
      name: "kimi",
      baseURL: "https://api.moonshot.ai/v1",
      apiKey: await requiredKey("Kimi", "moonshot-api-key", apiKeys?.kimi),
      fetch: aiSdkFetch,
    });
    return { provider, label: "Kimi K3", model: kimi(model), modelId: model };
  }
  if (provider === "azureOpenai") return createAzureAdapter(model, apiKeys);
  throw new Error(`Unsupported provider for model ${model}`);
}

export async function streamWithProvider(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  return streamAiSdk(params, await createProviderAdapter(params.model, params.apiKeys));
}

export async function completeWithProvider(
  params: CompleteProviderParams,
): Promise<string> {
  return completeAiSdkText(
    params,
    await createProviderAdapter(params.model, params.apiKeys),
  );
}
