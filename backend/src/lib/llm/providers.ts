import { isProviderDisabled } from "./providerPreferences";
import {
  aiSdkFetch,
  completeAiSdkText,
  streamAiSdk,
  maxOutputTokensFor,
  COMPLETION_REASONING_HEADROOM_TOKENS,
  type AiSdkAdapterConfig,
} from "./aiSdk";
import {
  azureClientTarget,
  azureCredentials,
  azureFoundryCredentials,
  bedrockCredentials,
  bedrockServiceUrl,
  CUSTOM_ENDPOINT_URL_LABEL,
  customEndpointCredentials,
  vertexCredentials,
} from "./cloudProviders";
import { guardedFetch } from "../mcp/client";
import { isBlockedDestinationError } from "../blockedDestination";
import { localModelToleranceMiddleware } from "./localModelMiddleware";
import { MANAGED_PROVIDERS, resolveManagedModel } from "./managedProviders";
import { ProviderConfigurationError, providerFailureResponse, type ProviderKeySource } from "./providerErrors";
import {
  ACCOUNT_MODEL_LABELS,
  accountModelPrefix,
  azureDeploymentName,
  azureFoundryDeploymentName,
  bedrockModelId,
  customEndpointModelId,
  isAzureFoundryClaudeDeployment,
  isOpenCodeGoChatCompletionsModel,
  isOpenCodeGoMessagesModel,
  isSafeAccountModel,
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
  ApiKeyName,
  ConfiguredModel,
  LlmFeature,
  Provider,
  ReasoningLevel,
  StreamChatParams,
  StreamChatResult,
  UserApiKeys,
} from "./types";
import {
  meterLlmCall,
  type LlmCallDescriptor,
  type LlmUsageMeter,
} from "./usage";
import { resolveSecret, resolveProviderSecret, resolveVercelApiKey } from "../envSecrets";
import { admitTenantLlmCall } from "../tenantRateLimit";
import { REASONING_LEVELS } from "./types";
import { vertexAuthClient } from "./vertexAuth";
import { UserFacingError } from "../safeError";
import { assertTenantModelAllowed, getTenantSettings, tenantSuppliesProvider } from "../tenantSettings";
import { memberApiKeysFor } from "./memberKeys";
import { log, tpl } from "../log";
import { providerDataRetentionAllowed } from "../runtimeConfig";

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
  feature?: LlmFeature;
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

/**
 * Per-request settings asking a provider not to keep, or train on, what Mike
 * sends it: lawyers' prompts and document text. Only providers whose API has
 * such a request field are listed; for the others (Anthropic, Gemini,
 * Vertex, Bedrock, Mistral) retention is set by the account's terms, not by
 * the request. LLM_PROVIDER_DATA_RETENTION=allow sends none of these.
 *
 * - OpenAI, Azure OpenAI and xAI Responses APIs store every response unless
 *   told not to. With store=false the SDKs ask for reasoning encrypted and
 *   hand it back inline on the next tool step instead of by stored id.
 * - OpenRouter routes only to upstreams that do not collect user data, and
 *   the Vercel AI Gateway only to providers that do not train on prompts;
 *   either can leave a model with no eligible upstream.
 */
const NO_RETENTION_OPTIONS: Partial<
  Record<Provider, AiSdkAdapterConfig["requestProviderOptions"]>
> = {
  openai: { openai: { store: false } },
  azure: { azure: { store: false } },
  xai: { xai: { store: false } },
  openrouter: { openrouter: { provider: { data_collection: "deny" } } },
  vercel: { gateway: { disallowPromptTraining: true } },
};

function noRetentionOptions(
  provider: Provider,
): AiSdkAdapterConfig["requestProviderOptions"] {
  return providerDataRetentionAllowed()
    ? undefined
    : NO_RETENTION_OPTIONS[provider];
}

/**
 * A provider with no key (upstream 2ada45fb). The user is told who can fix
 * it; the Key Vault secret that would fix it is the operator's configuration,
 * so it goes to the server log, never into a message every user can read.
 * Dev divergence: credentials are organisation-managed (no Bring Your Own
 * Keys page), so the remedy names the administrator, not Settings.
 */
function keyNotConfigured(label: string, operatorHint: string): UserFacingError {
  log.warn(tpl`[llm] ${label} API key is not configured. ${operatorHint}`);
  return new ProviderConfigurationError(
    `${label} is not configured for this organisation. Ask an administrator to configure it in /install.`,
  );
}

async function requiredKey(label: string, secretName: string, override?: string | null): Promise<string> {
  const aliases = secretName === "anthropic-api-key" ? ["claude-api-key"] : [];
  const key = override?.trim() || await resolveProviderSecret(secretName, aliases);
  if (!key) throw keyNotConfigured(label, `Set the ${secretName} Key Vault secret in /install.`);
  return key;
}

/**
 * Whose key a call for `provider` sends. The credential store lays saved
 * keys over the environment's, so `apiKeys[provider]` is often the
 * deployment's own key, and keySources says which (see UserApiKeys). An
 * empty entry means requiredKey, routerKey or the cloud credential helpers
 * fall back to the environment: the deployment's key too. A key without a
 * recorded origin (built outside the store) counts as the user's, the quiet
 * default: a refusal is then logged, never reported.
 */
function keySourceFor(
  apiKeys: UserApiKeys | undefined,
  provider: ApiKeyName,
): ProviderKeySource {
  // Dev: azureOpenai holds settings, not a key string.
  const key = apiKeys?.[provider];
  if (typeof key !== "string" || !key.trim()) return "deployment";
  const origin = apiKeys?.keySources?.[provider];
  if (origin === "env") return "deployment";
  return origin === "org" ? "org" : "user";
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
    throw keyNotConfigured(ROUTER_LABELS[provider], "Set the provider Key Vault secret in /install.");
  }
  return key;
}

async function createAnthropicAdapter(args: {
  provider: Extract<Provider, "claude" | "opencode-go" | "azure-foundry">;
  label: string;
  model: string;
  apiKey: string;
  keySource: ProviderKeySource;
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
    anthropicCachePoint: true,
    keySource: args.keySource,
    supportsReasoning: args.supportsReasoning,
    // Only Anthropic itself runs the search; compatible gateways do not.
    ...(args.provider === "claude"
      ? {
          webSearchTool: ({ maxUses }: { maxUses: number }) =>
            anthropic.tools.webSearch_20250305({ maxUses }),
        }
      : {}),
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
  const keySource = keySourceFor(apiKeys, provider);

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
      keySource,
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
      keySource,
    };
  }

  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const openCodeGo = createOpenAICompatible({
    name: "opencodeGo",
    apiKey: key,
    baseURL: OPENCODE_GO_BASE_URL,
    // Usage ledger (issue 015): ask for the final usage chunk when streaming.
    includeUsage: true,
    fetch: aiSdkFetch,
  });
  return {
    provider,
    label: ROUTER_LABELS[provider],
    model: openCodeGo(openCodeGoModelId(model)),
    modelId: model,
    keySource,
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
    throw keyNotConfigured(
      "Amazon Bedrock",
      "Set AWS_BEARER_TOKEN_BEDROCK and BEDROCK_AWS_REGION, or the user adds a key and region.",
    );
  }
  const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock");
  // An explicit apiKey makes the SDK use bearer auth and never fall back to
  // ambient AWS credentials (which a deployment may hold for S3 storage).
  const bedrock = createAmazonBedrock({
    apiKey: credentials.apiKey,
    region: credentials.region,
    // Explicit, or the SDK prefers AWS_ENDPOINT_URL_BEDROCK_RUNTIME /
    // AWS_ENDPOINT_URL from the environment and sends the key there.
    baseURL: bedrockServiceUrl("bedrock-runtime", credentials.region),
    fetch: aiSdkFetch,
  });
  const upstreamId = bedrockModelId(model);
  const isClaude = bedrockModelSupportsCachePoint(upstreamId);
  return {
    provider: "bedrock",
    label: "Amazon Bedrock",
    model: bedrock(upstreamId),
    modelId: model,
    keySource: keySourceFor(apiKeys, "bedrock"),
    bedrockCachePoint: isClaude,
    ...(isClaude
      ? { defaultMaxOutputTokens: await bedrockClaudeMaxOutputTokens(upstreamId) }
      : {}),
  };
}

/**
 * The output ceiling @ai-sdk/anthropic gives the same Claude model when it is
 * called directly (or on Vertex or Foundry): the model's own maximum, read
 * from the capability table both SDKs share (@ai-sdk/amazon-bedrock imports
 * it from @ai-sdk/anthropic/internal too). Without it Bedrock applies its own
 * small server default, which thinking also has to fit in.
 *
 * Budget-thinking models (older Claude, e.g. Haiku 4.5) are the exception
 * when reasoning is on: the Bedrock SDK adds the thinking budget ON TOP of
 * maxTokens, so sending the full cap would ask for more than the model
 * allows. Those keep the SDK's own budget + 4,096.
 */
export async function bedrockClaudeMaxOutputTokens(
  upstreamId: string,
): Promise<NonNullable<AiSdkAdapterConfig["defaultMaxOutputTokens"]>> {
  const { getModelCapabilities } = await import("@ai-sdk/anthropic/internal");
  const { maxOutputTokens, supportsAdaptiveThinking } =
    getModelCapabilities(upstreamId);
  return (reasoning) =>
    supportsAdaptiveThinking || !reasoning || reasoning === "none"
      ? maxOutputTokens
      : undefined;
}

async function createAzureAdapter(
  model: string,
  apiKeys?: UserApiKeys,
): Promise<AiSdkAdapterConfig> {
  const credentials = await azureCredentials(apiKeys);
  if (!credentials) {
    throw keyNotConfigured(
      "Azure OpenAI",
      "Set AZURE_API_KEY and AZURE_OPENAI_ENDPOINT, or the user adds a key and endpoint.",
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
    keySource: keySourceFor(apiKeys, "azure"),
    courtlistenerCitationReminder: true,
  };
}

async function createAzureFoundryAdapter(
  model: string,
  apiKeys?: UserApiKeys,
): Promise<AiSdkAdapterConfig> {
  const credentials = await azureFoundryCredentials(apiKeys);
  if (!credentials) {
    throw keyNotConfigured(
      "Azure AI Foundry",
      "Set AZURE_FOUNDRY_API_KEY and AZURE_FOUNDRY_ENDPOINT, or the user adds a key and endpoint.",
    );
  }
  const deployment = azureFoundryDeploymentName(model);
  const keySource = keySourceFor(apiKeys, "azure-foundry");
  if (isAzureFoundryClaudeDeployment(model)) {
    return createAnthropicAdapter({
      provider: "azure-foundry",
      label: "Azure AI Foundry",
      model: deployment,
      apiKey: credentials.apiKey,
      keySource,
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
    // Usage ledger (issue 015): ask for the final usage chunk when streaming.
    includeUsage: true,
    fetch: aiSdkFetch,
  });
  return {
    provider: "azure-foundry",
    label: "Azure AI Foundry",
    model: foundry(deployment),
    modelId: model,
    keySource,
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
  const base = {
    provider: "vertex" as const,
    label: "Google Vertex AI",
    modelId: model,
    keySource: keySourceFor(apiKeys, "vertex"),
  };
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
  blockedMessage = CUSTOM_ENDPOINT_BLOCKED_MESSAGE,
): Promise<Response> {
  try {
    return await aiSdkFetch(input, init, (url, options) =>
      guardedFetch(url, options, { label: CUSTOM_ENDPOINT_URL_LABEL }),
    );
  } catch (error) {
    // The base URL passed the save-time checks but now resolves to a
    // private or metadata address. That is the user's configuration to fix,
    // so say so instead of surfacing an internal error (or retrying it as a
    // network failure).
    if (isBlockedDestinationError(error)) {
      throw new UserFacingError(blockedMessage, {
        cause: error,
      });
    }
    throw error;
  }
}

const CUSTOM_ENDPOINT_BLOCKED_MESSAGE =
  "Your OpenAI-compatible endpoint's base URL does not resolve to a public address. Update it in Model Providers or select another model.";

async function createCustomEndpointAdapter(
  model: string,
  apiKeys?: UserApiKeys,
): Promise<AiSdkAdapterConfig> {
  const credentials = await customEndpointCredentials(apiKeys);
  if (!credentials) {
    throw new ProviderConfigurationError(
      "OpenAI-compatible endpoint is not configured. Add an API key and base URL in Settings → Bring Your Own Keys.",
    );
  }
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const client = createOpenAICompatible({
    name: "custom",
    apiKey: credentials.apiKey,
    baseURL: credentials.baseUrl,
    // Usage ledger (issue 015): ask for the final usage chunk when streaming.
    includeUsage: true,
    fetch: customEndpointFetch,
  });
  return {
    provider: "custom",
    label: "OpenAI-compatible endpoint",
    model: client(customEndpointModelId(model)),
    modelId: model,
    // Custom endpoints may belong to the user or their organization.
    keySource: keySourceFor(apiKeys, "custom"),
    supportsReasoning: false,
  };
}

const MANAGED_ENDPOINT_BLOCKED_MESSAGE =
  "This provider's base URL does not resolve to a public address. Ask an administrator to correct it, or select another model.";

/**
 * Organisation settings only: these providers never take a personal key.
 *
 * A BYO tenant's address is its own input to a shared stamp, so it gets the same
 * egress guard as a custom endpoint. Everywhere else the address comes from the
 * deployment's administrator, who may legitimately name a private gateway.
 */
async function createManagedAdapter(model: string): Promise<AiSdkAdapterConfig> {
  const resolved = await resolveManagedModel(model);
  if (!resolved.ok) throw new UserFacingError(resolved.detail);
  const guarded = await tenantSuppliesProvider(resolved.provider);
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const client = createOpenAICompatible({
    name: resolved.provider,
    apiKey: resolved.apiKey,
    baseURL: resolved.baseUrl,
    // Usage ledger (issue 015): ask for the final usage chunk when streaming.
    includeUsage: true,
    fetch: guarded
      ? (input, init) => customEndpointFetch(input, init, MANAGED_ENDPOINT_BLOCKED_MESSAGE)
      : aiSdkFetch,
  });
  return {
    provider: resolved.provider,
    label: MANAGED_PROVIDERS[resolved.provider].label,
    model: client(resolved.upstreamModel),
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
    throw new ProviderConfigurationError("This model provider is turned off. Turn it on in Settings → Bring Your Own Keys or select another model.");
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
    // Usage ledger (issue 015): ask for the final usage chunk when streaming.
    includeUsage: true,
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
    keySource: configuredModelKeySource(configured, apiKeys),
    supportsReasoning: false,
    replayReasoning: configured.replayReasoning === true,
  };
}

/**
 * Whose key a declared model sends, in apiKeyForConfiguredModel's order: a
 * key written into the declaration is the deployment's, then the user's own
 * key for apiKeyProvider, then the deployment's apiKeyEnv.
 */
function configuredModelKeySource(
  configured: ConfiguredModel,
  apiKeys?: UserApiKeys,
): ProviderKeySource {
  if (configured.apiKey?.trim() || !configured.apiKeyProvider) return "deployment";
  return keySourceFor(apiKeys, configured.apiKeyProvider);
}

function unsupportedOpenCodeGoModel(model: string): Error {
  return new Error(
    `OpenCode Go model ${openCodeGoModelId(model)} requires a protocol Mike does not support yet. Select a model listed under Model Selections for OpenCode Go in Settings → Bring Your Own Keys.`,
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
  const apiVersion = settings?.apiVersion?.trim() || await resolveSecret("azure-openai-api-version") || DEFAULT_AZURE_API_VERSION;
  if (!endpoint || !apiKey) throw new Error("Azure OpenAI is not configured for this organisation. Ask an administrator to set its endpoint and API key in /install.");
  const deployment = azureDeployment(model, settings ?? { endpoint, deployment: await resolveSecret("azure-openai-deployment") });
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
  nativeWebSearch = false,
): Promise<AiSdkAdapterConfig> {
  const adapter = await buildProviderAdapter(model, apiKeys, nativeWebSearch);
  const requestProviderOptions = noRetentionOptions(adapter.provider);
  return requestProviderOptions ? { ...adapter, requestProviderOptions } : adapter;
}

async function buildProviderAdapter(
  model: string,
  apiKeys?: UserApiKeys,
  nativeWebSearch = false,
): Promise<AiSdkAdapterConfig> {
  const provider = providerForModel(model);
  if (isProviderDisabled(provider, apiKeys)) {
    throw new ProviderConfigurationError("This model provider is turned off. Turn it on in Settings → Bring Your Own Keys or select another model.");
  }

  // Last line of defence behind resolveModel and the save-time check: some
  // SDKs (Vertex) put the model id into the request URL unencoded, so a
  // malformed id must never reach an adapter, whatever path it came from.
  const accountPrefix = accountModelPrefix(model);
  if (accountPrefix === provider && !isSafeAccountModel(model)) {
    throw new ProviderConfigurationError(
      `This is not a valid ${ACCOUNT_MODEL_LABELS[accountPrefix]} model id. Choose a model saved in Model Providers.`,
    );
  }

  if (provider === "claude") {
    return createAnthropicAdapter({
      provider,
      label: "Claude",
      model,
      apiKey: await requiredKey("Anthropic", "anthropic-api-key", apiKeys?.claude),
      keySource: keySourceFor(apiKeys, "claude"),
      supportsReasoning: true,
    });
  }

  if (provider === "gemini") {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    const google = createGoogleGenerativeAI({
      apiKey: await requiredKey("Gemini", "gemini-api-key", apiKeys?.gemini),
      fetch: aiSdkFetch,
    });
    return {
      provider,
      label: "Gemini",
      model: google(model),
      modelId: model,
      keySource: keySourceFor(apiKeys, "gemini"),
    };
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
      model: nativeWebSearch || process.env.OPENAI_API_MODE?.trim().toLowerCase() === "responses" ? openai.responses(model) : openai.chat(model),
      modelId: model,
      keySource: keySourceFor(apiKeys, "openai"),
      courtlistenerCitationReminder: true,
      webSearchTool: () => openai.tools.webSearch({}) as unknown as ReturnType<NonNullable<AiSdkAdapterConfig["webSearchTool"]>>,
    };
  }

  if (provider === "mistral") {
    const { createMistral } = await import("@ai-sdk/mistral");
    const mistral = createMistral({
      apiKey: await requiredKey("Mistral", "mistral-api-key", apiKeys?.mistral),
      fetch: aiSdkFetch,
    });
    return {
      provider,
      label: "Mistral",
      model: mistral(model),
      modelId: model,
      keySource: keySourceFor(apiKeys, "mistral"),
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
        keySource: keySourceFor(apiKeys, provider),
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
      // Usage ledger (issue 015): ask for the final usage chunk when streaming.
      includeUsage: true,
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
  if (provider === "tokenjuice" || provider === "meta") return createManagedAdapter(model);

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
      keySource: keySourceFor(apiKeys, "xai"),
    };
  }

  if (provider === "openai-compatible") {
    return createConfiguredAdapter(model, apiKeys);
  }
  throw new Error(`Unsupported provider for model ${model}`);
}

/**
 * Ledger descriptor for one call (issue 015). `apiKeys` here are the
 * organisation's credentials (getOrganisationApiKeys), not a user's. A tenant
 * call on the tenant's own key (byo, or hybrid with a reference) or on a
 * member's key is recorded as "byo": no platform credits are reserved.
 */
async function llmCall(model: string, feature: LlmFeature | undefined, memberKey = false): Promise<LlmCallDescriptor> {
  let provider: string;
  try {
    provider = providerForModel(model);
  } catch {
    provider = "unknown";
  }
  return {
    feature: feature ?? "unspecified",
    provider,
    model,
    keyMode: memberKey || await tenantSuppliesProvider(provider) ? "byo" : "platform",
  };
}

/** A tenant call keeps only the member's own key, and only for a listed model. */
async function tenantCallKeys<P extends { model: string; apiKeys?: UserApiKeys }>(
  params: P,
): Promise<{ params: P; memberKey: boolean }> {
  if (!(await getTenantSettings())) return { params, memberKey: false };
  const apiKeys = await memberApiKeysFor(params.model, params.apiKeys);
  return { params: { ...params, apiKeys }, memberKey: !!apiKeys };
}

export async function streamWithProvider(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  await assertTenantModelAllowed(params.model);
  const tenant = await tenantCallKeys(params);
  params = tenant.params;
  // Shared per-tenant limits (issue 017): refused calls never reach the
  // provider and record no ledger row.
  await admitTenantLlmCall();
  // Usage ledger (issue 015): one row per call, including the reasoning
  // fallback retry below, aborted streams and failures.
  return meterLlmCall(
    await llmCall(params.model, params.feature, tenant.memberKey),
    (meter) => streamWithProviderMetered(params, meter),
    params.abortSignal,
    { prompt: { system: params.systemPrompt, messages: params.messages, tools: params.tools }, maxOutputTokens: maxOutputTokensFor(providerForModel(params.model)) },
  );
}

async function streamWithProviderMetered(
  params: StreamChatParams,
  meter: LlmUsageMeter,
): Promise<StreamChatResult> {
  const normalizedParams = {
    ...params,
    reasoning: normalizeReasoningLevelForModel(
      params.model,
      params.reasoning ?? "none",
    ),
  };
  let streamed = false;
  const marking =
    <A extends unknown[]>(callback?: (...args: A) => void) =>
    (...args: A) => {
      streamed = true;
      callback?.(...args);
    };
  const callbacks = params.callbacks;
  const tracked: StreamChatParams = {
    ...normalizedParams,
    callbacks: callbacks && {
      ...callbacks,
      onContentDelta: marking(callbacks.onContentDelta),
      onReasoningDelta: marking(callbacks.onReasoningDelta),
      onToolCallStart: marking(callbacks.onToolCallStart),
      onWebSearch: marking(callbacks.onWebSearch),
    },
  };
  try {
    return await streamAiSdk(
      tracked,
      await createProviderAdapter(params.model, params.apiKeys, !!params.providerWebSearch),
      meter,
    );
  } catch (error) {
    const retryReasoning = fallbackReasoningLevelFromProviderError(
      error,
      normalizedParams.reasoning,
    );
    if (retryReasoning) {
      meter.discardUnbilledStep();
      return streamAiSdk(
        { ...normalizedParams, reasoning: retryReasoning },
        await createProviderAdapter(params.model, params.apiKeys, !!params.providerWebSearch),
        meter,
      );
    }
    if (shouldRetryWithoutWebSearch(error, params, streamed)) {
      // The provider refused the request before any inference ran.
      meter.discardUnbilledStep();
      params.callbacks?.onWebSearch?.({ kind: "unavailable" });
      return streamAiSdk(
        {
          ...normalizedParams,
          systemPrompt: `${normalizedParams.systemPrompt}\n\nWeb search is unavailable for this answer.`,
          providerWebSearch: null,
        },
        await createProviderAdapter(params.model, params.apiKeys),
        meter,
      );
    }
    throw error;
  }
}

/**
 * The provider refused the request itself because of its web search tool:
 * the model does not support it, or the account has not turned it on. Once
 * output has streamed, a retry would show it twice.
 */
function shouldRetryWithoutWebSearch(
  error: unknown,
  params: StreamChatParams,
  streamed: boolean,
): boolean {
  return !!params.providerWebSearch && !streamed && isWebSearchRejection(error);
}

function isWebSearchRejection(error: unknown): boolean {
  const response = providerFailureResponse(error);
  return (
    response !== null &&
    response.status >= 400 &&
    response.status < 500 &&
    /web[_ ]?search/i.test(response.body)
  );
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
  await assertTenantModelAllowed(params.model);
  const tenant = await tenantCallKeys(params);
  params = tenant.params;
  await admitTenantLlmCall();
  // Reserve what completeAiSdkText may ask for, reasoning headroom included.
  const requestedOutput = params.maxTokens ?? 512;
  const completionReasoning = normalizeReasoningLevelForModel(params.model, params.reasoningEffort ?? "none");
  const reservedOutput = completionReasoning && completionReasoning !== "none"
    ? requestedOutput + COMPLETION_REASONING_HEADROOM_TOKENS : requestedOutput;
  return meterLlmCall(
    await llmCall(params.model, params.feature, tenant.memberKey),
    async (meter) =>
      completeAiSdkText(
        params,
        await createProviderAdapter(params.model, params.apiKeys),
        meter,
      ),
    params.abortSignal,
    { prompt: { system: params.systemPrompt, user: params.user }, maxOutputTokens: reservedOutput },
  );
}
