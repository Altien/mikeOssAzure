import { createServerSupabase } from "./supabase";
import {
    resolveModel,
    DEFAULT_TITLE_MODEL,
    DEFAULT_TABULAR_MODEL,
    OPENAI_LOW_MODELS,
    type UserApiKeys,
} from "./llm";
import { getUserApiKeys as getStoredUserApiKeys } from "./userApiKeys";
import { getUserRouterModels } from "./routerModels";

export type UserModelSettings = {
    title_model: string;
    tabular_model: string;
    legal_research_us: boolean;
    api_keys: UserApiKeys;
};

// Title generation is a lightweight task — always routed to the cheapest model
// of whichever provider the user has keys for: Gemini Flash Lite if Gemini is
// available, otherwise OpenAI lite, Claude Haiku, or the user's first saved
// router model. With no usable provider, defaults to Gemini (the dev-mode env
// fallback).
function resolveTitleModel(
    apiKeys: UserApiKeys,
    openRouterModels: string[],
    vercelModels: string[],
): string {
    if (apiKeys.gemini?.trim()) return DEFAULT_TITLE_MODEL;
    if (apiKeys.openai?.trim()) return OPENAI_LOW_MODELS[0];
    if (apiKeys.claude?.trim()) return "claude-haiku-4-5";
    if (apiKeys.openrouter?.trim() && openRouterModels[0]) {
        return `openrouter/${openRouterModels[0]}`;
    }
    if (apiKeys.vercel?.trim() && vercelModels[0]) {
        return `vercel/${vercelModels[0]}`;
    }
    return DEFAULT_TITLE_MODEL;
}

export async function getUserModelSettings(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserModelSettings> {
    const client = db ?? createServerSupabase();
    const [profileResult, api_keys, openRouterModels, vercelModels] =
        await Promise.all([
            client
                .from("user_profiles")
                .select("title_model, tabular_model, legal_research_us")
                .eq("user_id", userId)
                .single(),
            getStoredUserApiKeys(userId, client),
            getUserRouterModels(userId, "openrouter", client),
            getUserRouterModels(userId, "vercel", client),
        ]);
    const data = profileResult.data;

    return {
        title_model: resolveModel(
            data?.title_model,
            resolveTitleModel(api_keys, openRouterModels, vercelModels),
        ),
        tabular_model: resolveModel(data?.tabular_model, DEFAULT_TABULAR_MODEL),
        legal_research_us:
            (data as { legal_research_us?: boolean | null } | null)
                ?.legal_research_us !== false,
        api_keys,
    };
}

export async function getUserApiKeys(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserApiKeys> {
    const client = db ?? createServerSupabase();
    return getStoredUserApiKeys(userId, client);
}
