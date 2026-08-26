// Shared types for the LLM provider adapter.
// Callers always speak OpenAI-style tools + { role, content } messages; each
// provider translates internally.

export type Provider =
    | "claude"
    | "gemini"
    | "openai"
    | "kimi"
    | "azureOpenai"
    | "openrouter"
    | "opencode-go"
    | "vercel";

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
    gemini?: string | null;
    openai?: string | null;
    kimi?: string | null;
    openrouter?: string | null;
    vercel?: string | null;
    "opencode-go"?: string | null;
    courtlistener?: string | null;
    azureOpenai?: AzureOpenaiSettings | null;
};

// Azure OpenAI needs endpoint, API key, deployment and API version. The
// optional field represents legacy stored settings; inference currently
// requires either that key or the organisation Key Vault credential.
export type AzureOpenaiSettings = {
    endpoint: string;
    apiKey?: string | null;
    deployment: string;
    apiVersion?: string | null;
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
};

export type StreamChatResult = {
    fullText: string;
};
