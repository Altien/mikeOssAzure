import { isProviderDisabled } from "./providerPreferences";
import {
  aiSdkFetch,
  completeAiSdkText,
  streamAiSdk,
  type AiSdkAdapterConfig,
} from "./aiSdk";
import {
  azureClientTarget,
  azureCredentials,
  azureFoundryCredentials,
  bedrockCredentials,
  customEndpointCredentials,
  vertexCredentials,
} from "./cloudProviders";
import { guardedFetch } from "../mcp/client";
import { localModelToleranceMiddleware } from "./localModelMiddleware";
import {
  azureDeploymentName,
  azureFoundryDeploymentName,
  bedrockModelId,
  customEndpointModelId,
  isAzureFoundryClaudeDeployment,
  isOpenCodeGoChatCompletionsModel,
  isOpenCodeGoMessagesModel,
  normalizeReasoningLevelForModel,
  openCodeGoModelId,
  openRouterModelId,
  providerForModel,
  vercelModelId,
  vertexModelId,
  vertexModelProtocol,
  xaiModelId,
} from "./models";
import {
  apiKeyForConfiguredModel,
  configuredModelRequiresApiKey,
  getConfiguredModel,
  tolerateTextToolCalls,
} from "./registry";
import type {
  ConfiguredModel,
  Provider,
  ReasoningLevel,
  StreamChatParams,
  StreamChatResult,
  UserApiKeys,
} from "./types";
import { resolveSecret, resolveProviderSecret, resolveVercelApiKey } from "../envSecrets";
import { REASONING_LEVELS } from "./types";
import { vertexAuthClient } from "./vertexAuth";
import { UserFacingError } from "../safeError";

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
  abortSignal?: AbortSignal;
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
  const aliases = secretName === "anthropic-api-key" ? ["claude-api-key"] : [];
  const key = override?.trim() || await resolveProviderSecret(secretName, aliases);
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
  provider: Extract<Provider, "claude" | "opencode-go" | "azure-foundry">;
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

/**
 * Bedrock's prompt caching takes an explicit cache point, which most Bedrock
 * models reject, so it is only sent to Claude. Claude ids appear bare
 * ("anthropic.claude-…"), behind a cross-region profile prefix
 * ("us.anthropic.claude-…") or inside an inference-profile ARN.
 */
export function bedrockModelSupportsCachePoint(modelId: string): boolean {
  return /(?:^|[./])anthropic\.claude-/.test(modelId);
}

async function createBedrockAdapter(
  model: string,
  apiKeys?: UserApiKeys,
): Promise<AiSdkAdapterConfig> {
  const credentials = await bedrockCredentials(apiKeys);
  if (!credentials) {
    throw new Error(
      "Amazon Bedrock API key is not configured. Set AWS_BEARER_TOKEN_BEDROCK and BEDROCK_AWS_REGION or add a user Amazon Bedrock key and region.",
    );
  }
  const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock");
  // An explicit apiKey makes the SDK use bearer auth and never fall back to
  // ambient AWS credentials (which a deployment may hold for S3 storage).
  const bedrock = createAmazonBedrock({
    apiKey: credentials.apiKey,
    region: credentials.region,
    fetch: aiSdkFetch,
  });
  const upstreamId = bedrockModelId(model);
  return {
    provider: "bedrock",
    label: "Amazon Bedrock",
    model: bedrock(upstreamId),
    modelId: model,
    bedrockCachePoint: bedrockModelSupportsCachePoint(upstreamId),
  };
}

async function createAzureAdapter(
  model: string,
  apiKeys?: UserApiKeys,
): Promise<AiSdkAdapterConfig> {
  const credentials = await azureCredentials(apiKeys);
  if (!credentials) {
    throw new Error(
      "Azure OpenAI API key is not configured. Set AZURE_API_KEY and AZURE_OPENAI_ENDPOINT or add a user Azure OpenAI key and endpoint.",
    );
  }
  const { createAzure } = await import("@ai-sdk/azure");
  const azure = createAzure({
    apiKey: credentials.apiKey,
    ...azureClientTarget(credentials.endpoint),
    fetch: aiSdkFetch,
  });
  return {
    provider: "azure",
    label: "Azure OpenAI",
    // The deployment name doubles as the model id the SDK uses to infer
    // reasoning support, so deployments named after their model ("gpt-6.1-sol")
    // get reasoning controls and arbitrary names run without them.
    model: azure.responses(azureDeploymentName(model)),
    modelId: model,
    courtlistenerCitationReminder: true,
  };
}

async function createAzureFoundryAdapter(
  model: string,
  apiKeys?: UserApiKeys,
): Promise<AiSdkAdapterConfig> {
  const credentials = await azureFoundryCredentials(apiKeys);
  if (!credentials) {
    throw new Error(
      "Azure AI Foundry API key is not configured. Set AZURE_FOUNDRY_API_KEY and AZURE_FOUNDRY_ENDPOINT or add a user Azure AI Foundry key and endpoint.",
    );
  }
  const deployment = azureFoundryDeploymentName(model);
  if (isAzureFoundryClaudeDeployment(model)) {
    return createAnthropicAdapter({
      provider: "azure-foundry",
      label: "Azure AI Foundry",
      model: deployment,
      apiKey: credentials.apiKey,
      baseURL: `${credentials.endpoint}/anthropic/v1`,
      supportsReasoning: true,
    });
  }
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const foundry = createOpenAICompatible({
    name: "azureFoundry",
    apiKey: credentials.apiKey,
    // The v1 endpoint takes the key as a bearer token or as Azure's own
    // header; sending both covers resources that only accept one.
    headers: { "api-key": credentials.apiKey },
    baseURL: `${credentials.endpoint}/openai/v1`,
    fetch: aiSdkFetch,
  });
  return {
    provider: "azure-foundry",
    label: "Azure AI Foundry",
    model: foundry(deployment),
    modelId: model,
    supportsReasoning: false,
  };
}

async function createVertexAdapter(
  model: string,
  apiKeys?: UserApiKeys,
): Promise<AiSdkAdapterConfig> {
  const credentials = await vertexCredentials(apiKeys);
  if (!credentials) {
    throw new Error(
      "Google Vertex AI credentials are not configured. Set GOOGLE_VERTEX_CREDENTIALS_JSON and GOOGLE_VERTEX_LOCATION or add a user Vertex AI service-account key and location.",
    );
  }
  // A ready-made auth client keeps google-auth-library from ever looking for
  // ambient credentials (a deployment may hold its own for storage).
  const settings = {
    project: credentials.project,
    location: credentials.location,
    googleAuthOptions: { authClient: await vertexAuthClient(credentials) },
    fetch: aiSdkFetch,
  };
  const upstreamId = vertexModelId(model);
  const base = { provider: "vertex" as const, label: "Google Vertex AI", modelId: model };
  const protocol = vertexModelProtocol(model);
  if (protocol === "anthropic") {
    const { createVertexAnthropic } = await import(
      "@ai-sdk/google-vertex/anthropic"
    );
    return { ...base, model: createVertexAnthropic(settings)(upstreamId) };
  }
  if (protocol === "maas") {
    const { createVertexMaas } = await import("@ai-sdk/google-vertex/maas");
    return {
      ...base,
      model: createVertexMaas(settings)(upstreamId),
      supportsReasoning: false,
    };
  }
  const { createVertex } = await import("@ai-sdk/google-vertex");
  // An explicit empty apiKey stops the SDK from switching to express mode on
  // a GOOGLE_VERTEX_API_KEY in the environment, which would bypass the
  // service account chosen above.
  const vertex = createVertex({ ...settings, apiKey: "" });
  return { ...base, model: vertex(upstreamId) };
}

/**
 * Egress for a user-supplied base URL: https only, never a private or
 * metadata address, pinned to the address that was validated.
 */
async function customEndpointFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return aiSdkFetch(input, init, guardedFetch);
}

async function createCustomEndpointAdapter(
  model: string,
  apiKeys?: UserApiKeys,
): Promise<AiSdkAdapterConfig> {
  const credentials = await customEndpointCredentials(apiKeys);
  if (!credentials) {
    throw new Error(
      "OpenAI-compatible endpoint is not configured. Add an API key and base URL in Settings → Bring Your Own Keys.",
    );
  }
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const client = createOpenAICompatible({
    name: "custom",
    apiKey: credentials.apiKey,
    baseURL: credentials.baseUrl,
    fetch: customEndpointFetch,
  });
  return {
    provider: "custom",
    label: "OpenAI-compatible endpoint",
    model: client(customEndpointModelId(model)),
    modelId: model,
    supportsReasoning: false,
  };
}

function configuredModelOrThrow(id: string): ConfiguredModel {
  const configured = getConfiguredModel(id);
  if (!configured) {
    throw new Error(
      `Model ${id} is not declared in MIKE_MODEL_CONFIG_JSON.`,
    );
  }
  if (!configured.baseUrl?.trim()) {
    throw new Error(`Configured model ${id} is missing a baseUrl.`);
  }
  return configured;
}

async function createConfiguredAdapter(
  id: string,
  apiKeys?: UserApiKeys,
): Promise<AiSdkAdapterConfig> {
  const configured = configuredModelOrThrow(id);
  if (configured.apiKeyProvider && isProviderDisabled(configured.apiKeyProvider, apiKeys)) {
    throw new UserFacingError("This model provider is turned off. Turn it on in Settings → Bring Your Own Keys or select another model.");
  }
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const apiKey = await apiKeyForConfiguredModel(configured, apiKeys);
  if (configuredModelRequiresApiKey(configured) && !apiKey) {
    throw new Error(`${configured.label || configured.id} is not configured for this organisation. Ask an administrator to set its credential in /install.`);
  }
  const client = createOpenAICompatible({
    name: configured.id,
    baseURL: configured.baseUrl,
    // Omit Authorization entirely for endpoints declared without auth.
    ...(apiKey ? { apiKey } : {}),
    ...(configured.maxTokensField === "max_completion_tokens"
      ? {
          transformRequestBody: (body: Record<string, unknown>) => {
            const { max_tokens: maxTokens, ...rest } = body;
            return maxTokens === undefined
              ? rest
              : { ...rest, max_completion_tokens: maxTokens };
          },
        }
      : {}),
    fetch: aiSdkFetch,
  });
  const base = client(configured.apiModel ?? configured.id);
  const { wrapLanguageModel } = await import("ai");
  return {
    provider: "openai-compatible",
    label: configured.label || configured.id,
    model: tolerateTextToolCalls(configured)
      ? wrapLanguageModel({
          model: base,
          middleware: localModelToleranceMiddleware(),
        })
      : base,
    modelId: configured.id,
    supportsReasoning: false,
  };
}

function unsupportedOpenCodeGoModel(model: string): Error {
  return new Error(
    `OpenCode Go model ${openCodeGoModelId(model)} requires a protocol Mike does not support yet. Select a model listed under OpenCode Go in Settings → Bring Your Own Keys.`,
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

async function createLegacyAzureAdapter(model: string, apiKeys?: UserApiKeys): Promise<AiSdkAdapterConfig> {
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
  if (isProviderDisabled(provider, apiKeys)) {
    throw new UserFacingError("This model provider is turned off. Turn it on in Settings → Bring Your Own Keys or select another model.");
  }

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

  if (provider === "mistral") {
    const { createMistral } = await import("@ai-sdk/mistral");
    const mistral = createMistral({
      apiKey: await requiredKey("Mistral", "mistral-api-key", apiKeys?.mistral),
      fetch: aiSdkFetch,
    });
    return { provider, label: "Mistral", model: mistral(model), modelId: model };
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
  if (provider === "azureOpenai") return createLegacyAzureAdapter(model, apiKeys);
  if (provider === "bedrock") return createBedrockAdapter(model, apiKeys);
  if (provider === "azure") return createAzureAdapter(model, apiKeys);
  if (provider === "azure-foundry") {
    return createAzureFoundryAdapter(model, apiKeys);
  }
  if (provider === "vertex") return createVertexAdapter(model, apiKeys);
  if (provider === "custom") return createCustomEndpointAdapter(model, apiKeys);

  if (provider === "xai") {
    const { createXai } = await import("@ai-sdk/xai");
    const xai = createXai({
      apiKey: await requiredKey("xAI", "xai-api-key", apiKeys?.xai),
      fetch: aiSdkFetch,
    });
    return {
      provider,
      label: "xAI",
      model: xai(xaiModelId(model)),
      modelId: model,
    };
  }

  if (provider === "openai-compatible") {
    return createConfiguredAdapter(model, apiKeys);
  }
  throw new Error(`Unsupported provider for model ${model}`);
}

export async function streamWithProvider(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const normalizedParams = {
    ...params,
    reasoning: normalizeReasoningLevelForModel(
      params.model,
      params.reasoning ?? "none",
    ),
  };
  try {
    return await streamAiSdk(
      normalizedParams,
      await createProviderAdapter(params.model, params.apiKeys),
    );
  } catch (error) {
    const retryReasoning = fallbackReasoningLevelFromProviderError(
      error,
      normalizedParams.reasoning,
    );
    if (retryReasoning) {
      return streamAiSdk(
        { ...normalizedParams, reasoning: retryReasoning },
        await createProviderAdapter(params.model, params.apiKeys),
      );
    }
    throw error;
  }
}

/**
 * Provider model capabilities can change ahead of the SDK's shared types.
 * Retry request-validation failures at the nearest level advertised by the
 * provider, before any stream content has been emitted.
 */
export function fallbackReasoningLevelFromProviderError(
  error: unknown,
  requested: ReasoningLevel | undefined,
): ReasoningLevel | undefined {
  if (!requested) return undefined;
  const message = error instanceof Error ? error.message : String(error);
  const marker = "supported values are:";
  const markerIndex = message.toLocaleLowerCase().indexOf(marker);
  if (markerIndex < 0) return undefined;
  const supportedText = message.slice(markerIndex + marker.length).trimStart();
  if (!supportedText) return undefined;

  const supported = [...supportedText.matchAll(/'([^']+)'/g)]
    .map((match) => match[1])
    .filter(
      (level): level is ReasoningLevel =>
        !!level && (REASONING_LEVELS as readonly string[]).includes(level),
    );
  if (!supported.length || supported.includes(requested)) return undefined;

  const requestedIndex = REASONING_LEVELS.indexOf(requested);
  return supported.reduce((nearest, candidate) => {
    const nearestDistance = Math.abs(
      REASONING_LEVELS.indexOf(nearest) - requestedIndex,
    );
    const candidateDistance = Math.abs(
      REASONING_LEVELS.indexOf(candidate) - requestedIndex,
    );
    return candidateDistance <= nearestDistance ? candidate : nearest;
  });
}

export async function completeWithProvider(
  params: CompleteProviderParams,
): Promise<string> {
  return completeAiSdkText(
    params,
    await createProviderAdapter(params.model, params.apiKeys),
  );
}
