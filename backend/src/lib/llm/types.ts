// Shared types for the LLM provider adapter.
// Callers always speak OpenAI-style tools + { role, content } messages; each
// provider translates internally.

export type Provider =
    | "claude"
    | "gemini"
    | "openai"
    | "openai-compatible"
    | "openrouter"
    | "vercel"
    | "opencode-go"
    | "synthetic"
    | "ollama";

export const REASONING_LEVELS = [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export type OpenAIToolSchema = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
};

export type LlmMessage = {
    role: "user" | "assistant";
    content: string;
};

export type NormalizedToolCall = {
    id: string;
    name: string;
    input: Record<string, unknown>;
};

export type NormalizedToolResult = {
    tool_use_id: string;
    content: string;
};

export type StreamCallbacks = {
    onReasoningDelta?: (text: string) => void;
    onReasoningBlockEnd?: () => void;
    onContentDelta?: (text: string) => void;
    onToolCallStart?: (call: NormalizedToolCall) => void;
};

export type UserApiKeys = {
    claude?: string | null;
    kimi?: string | null;
    gemini?: string | null;
    openai?: string | null;
    openrouter?: string | null;
    vercel?: string | null;
    "opencode-go"?: string | null;
    synthetic?: string | null;
    courtlistener?: string | null;
};

export type StreamChatParams = {
    model: string;
    systemPrompt: string;
    messages: LlmMessage[];
    tools?: OpenAIToolSchema[];
    maxIterations?: number;
    callbacks?: StreamCallbacks;
    runTools?: (calls: NormalizedToolCall[]) => Promise<NormalizedToolResult[]>;
    apiKeys?: UserApiKeys;
    /**
     * AI SDK reasoning effort. Bulk extraction jobs should leave this unset;
     * the SDK adapter maps an omitted level to "none" to save tokens and
     * latency.
     */
    reasoning?: ReasoningLevel;
    abortSignal?: AbortSignal;
    /**
     * Maximum time allowed for each provider response. Providers that do not
     * expose an abortable request may ignore this value.
     */
    requestTimeoutMs?: number;
};

export type StreamChatResult = {
    fullText: string;
};

export type ModelLocation = "cloud" | "local";

export type ConfiguredModel = {
    id: string;
    provider: Provider;
    location: ModelLocation;
    label?: string;
    apiModel?: string;
    modelName?: string;
    baseUrl?: string;
    apiKeyEnv?: string;
    apiKeyProvider?: keyof UserApiKeys;
    apiKey?: string;
    extraBody?: Record<string, unknown>;
    /** Enable chunked Assistant playbook passes for this model. */
    playbookChunking?: boolean;
    /** Context window in tokens. Used to decide when to chunk attached docs. */
    contextWindow?: number;
};

export type CommitteeModel = {
    id: string;
    label?: string;
    members: Array<
        | string
        | {
              id?: string;
              model: string;
              label?: string;
              systemPrompt?: string;
          }
    >;
    chair: string;
    strategy?: "synthesize";
};
