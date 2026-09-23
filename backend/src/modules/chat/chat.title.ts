import { completeText, type UserApiKeys } from "../../lib/llm";
import { providerFailureStatus } from "../../lib/llm/providerErrors";
import { UserFacingError } from "../../lib/userFacingError";

/**
 * Log a failed BACKGROUND title generation — the one the chat stream routes
 * start alongside the model's reply.
 *
 * That title call uses the same API keys (and, unless a title model is
 * configured, the same provider) as the reply. When the provider refuses it
 * — a rejected key, no credit, a rate limit, an outage — the reply fails for
 * the same reason and runLLMStream reports that once, classified and tagged.
 * Logging this copy with console.error made the Sentry console bridge file
 * the same failure again as its own issue (MIKE-BACKEND-D). A missing key
 * (UserFacingError) is the same story. Those stay in the operator's logs as
 * a warning; anything else — a failed title write, a bug — is still an
 * error, because nothing else will report it.
 */
export function logChatTitleFailure(label: string, error: unknown): void {
    if (
        error instanceof UserFacingError ||
        providerFailureStatus(error) !== null
    ) {
        console.warn(label, error);
        return;
    }
    console.error(label, error);
}

const TITLE_FALLBACK = "Misc. Query";

function normalizeGeneratedTitle(raw: string): string {
    const title = raw
        .trim()
        .replace(/^["'`]+|["'`.,:;!?]+$/g, "")
        .trim();
    if (!title) return TITLE_FALLBACK;
    return title.slice(0, 80);
}

export async function generateAssistantChatTitle(args: {
    model: string;
    message: string;
    apiKeys?: UserApiKeys;
}): Promise<string> {
    const titleText = await completeText({
        model: args.model,
        user: `Generate a concise title (3–6 words) for a chat in an AI Legal Platform that starts with this message. The title should describe the topic or document — do NOT include words like "Legal Assistant", "AI", "Chat", or any similar prefix. If there is not enough information to generate a title, return exactly "${TITLE_FALLBACK}". Return only the title, no quotes or punctuation.\n\nMessage: ${args.message.slice(0, 500)}`,
        maxTokens: 64,
        // Dev may use a reasoning model as the fast/title model. Reserve the
        // small title budget for the answer instead of hidden reasoning.
        reasoningEffort: "none",
        apiKeys: args.apiKeys,
    });
    return normalizeGeneratedTitle(titleText);
}
