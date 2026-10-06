import { createServerSupabase, type Db } from "../../lib/supabase";
import { DEFAULT_TITLE_MODEL, OPENAI_LOW_MODELS, type UserApiKeys, type ReasoningLevel } from "../../lib/llm";
import { getOrganisationApiKeys } from "./user.apiKeyStore";
import { loadCustomInstructions } from "./user.customInstructions";
import {
    DEFAULT_RESPONSE_STYLE,
    loadResponseStyle,
    type ResponseStyle,
} from "./user.responseStyle";
import { safeError } from "../../lib/safeError";
import { getAllUserRouterModels, ROUTER_SLUGS, type RouterModelSelections } from "../../lib/routerModels";
import { normalizeOptionalModelPreference, normalizeReasoningLevel } from "../../lib/modelSelection";

export type UserModelSettings = {
    /** Existing internal title helper for Altien skill paths. */
    fast_model: string;
    /** Explicit title override stored in Dev's fast_model; null derives from chat model. */
    title_model: string | null;
    tabular_model: string | null;
    /** Explicit override for asynchronous memory curation. */
    memory_curator_model: string | null;
    /** Cross-surface fallback used only when a chat has no usable model. */
    last_selected_chat_model: string | null;
    last_selected_reasoning_level: ReasoningLevel | null;
    legal_research_us: boolean;
    api_keys: UserApiKeys;
    personalisation?: {
        displayName: string | null;
        organisation: string | null;
        jurisdiction: string | null;
        practiceSetting: string | null;
        professionalTitle: string | null;
        practiceAreas: string[];
        /** Free-form instructions from Settings > Personalisation. */
        customInstructions?: string;
        /** Response style from Settings > Personalisation. */
        responseStyle?: ResponseStyle;
    };
};

function fallbackTitleModel(apiKeys: UserApiKeys, routerModels: RouterModelSelections): string {
    if (apiKeys.gemini?.trim()) return DEFAULT_TITLE_MODEL;
    if (apiKeys.openai?.trim()) return OPENAI_LOW_MODELS[0];
    if (apiKeys.claude?.trim()) return "claude-haiku-4-5";
    if (apiKeys.kimi?.trim()) return "kimi-k3";
    if (apiKeys.azureOpenai?.apiKey?.trim() && apiKeys.azureOpenai.deployment?.trim()) return `aoai:${apiKeys.azureOpenai.deployment}`;
    for (const slug of ROUTER_SLUGS) {
        const first = routerModels[slug][0];
        if (apiKeys[slug]?.trim() && first) return `${slug}/${first}`;
    }
    return DEFAULT_TITLE_MODEL;
}

export async function getUserModelSettings(
    userId: string,
    db?: Db,
): Promise<UserModelSettings> {
    const client = db ?? createServerSupabase();
    const [profileResult, api_keys, routerModels, customInstructions, responseStyle] = await Promise.all([
        client.from("user_profiles")
            .select("fast_model, tabular_model, memory_curator_model, last_selected_chat_model, last_selected_reasoning_level, legal_research_us, display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas")
            .eq("user_id", userId).single(),
        getOrganisationApiKeys(),
        getAllUserRouterModels(userId, client),
        // Instructions are an enhancement: a failed read must not block chat.
        loadCustomInstructions(client, userId).catch((error: unknown) => {
            console.error(
                "[user-settings] custom instructions load failed",
                safeError(error),
            );
            return "";
        }),
        loadResponseStyle(client, userId).catch((error: unknown) => {
            console.error(
                "[user-settings] response style load failed",
                safeError(error),
            );
            return DEFAULT_RESPONSE_STYLE;
        }),
    ]);
    let data = profileResult.data;
    let profileError = profileResult.error;
    if (profileError?.code === "42703" && profileError.message?.includes("memory_curator_model")) {
        const previous = await client.from("user_profiles")
            .select("fast_model, tabular_model, last_selected_chat_model, last_selected_reasoning_level, legal_research_us, display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas")
            .eq("user_id", userId).single();
        data = previous.error ? null : { ...previous.data, memory_curator_model: null } as typeof data;
        profileError = previous.error;
    }
    if (profileError?.code === "42703") {
        const withoutReasoning = await client.from("user_profiles")
            .select("fast_model, tabular_model, last_selected_chat_model, legal_research_us, display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas")
            .eq("user_id", userId).single();
        if (!withoutReasoning.error) {
            data = { ...withoutReasoning.data, last_selected_reasoning_level: null } as typeof data;
        } else if (withoutReasoning.error.code === "42703") {
        const withoutLastUsed = await client.from("user_profiles")
            .select("fast_model, tabular_model, legal_research_us, display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas")
            .eq("user_id", userId).single();
        if (!withoutLastUsed.error) {
            data = { ...withoutLastUsed.data, last_selected_chat_model: null } as typeof data;
        } else if (withoutLastUsed.error.code === "42703") {
            const legacy = await client.from("user_profiles")
                .select("fast_model, tabular_model, legal_research_us")
                .eq("user_id", userId).single();
            if (legacy.error) throw new Error(`Failed to read legacy user model settings: ${legacy.error.message}`);
            data = { ...legacy.data, last_selected_chat_model: null } as typeof data;
        } else {
            throw new Error(`Failed to read user model settings: ${withoutLastUsed.error.message}`);
        }
        } else {
            throw new Error(`Failed to read user model settings: ${withoutReasoning.error.message}`);
        }
    } else if (profileError) {
        throw new Error(`Failed to read user model settings: ${profileError.message}`);
    }
    const optional = (value: string | null | undefined) =>
        normalizeOptionalModelPreference(value, routerModels);
    const titleOverride = optional(data?.fast_model);
    return {
        fast_model: titleOverride ?? fallbackTitleModel(api_keys, routerModels),
        title_model: titleOverride,
        tabular_model: optional(data?.tabular_model),
        memory_curator_model: optional(data?.memory_curator_model),
        last_selected_chat_model: optional(data?.last_selected_chat_model),
        last_selected_reasoning_level: normalizeReasoningLevel(data?.last_selected_reasoning_level),
        legal_research_us: data?.legal_research_us !== false,
        personalisation: {
            displayName: typeof data?.display_name === "string" ? data.display_name : null,
            organisation: typeof data?.organisation === "string" ? data.organisation : null,
            jurisdiction: typeof data?.jurisdiction === "string" ? data.jurisdiction : null,
            practiceSetting: typeof data?.practice_setting === "string" ? data.practice_setting : null,
            professionalTitle: typeof data?.professional_title === "string" ? data.professional_title : null,
            practiceAreas: Array.isArray(data?.practice_areas) ? data.practice_areas.filter((a): a is string => typeof a === "string") : [],
            customInstructions,
            responseStyle,
        },
        api_keys,
    };
}

/** Save only a completed turn; concurrent identity is bound by the caller. */
export async function persistLastSelectedChatModel(
    userId: string,
    model: string,
    db: Db,
): Promise<unknown | null> {
    const { error } = await db.from("user_profiles")
        .update({ last_selected_chat_model: model, updated_at: new Date().toISOString() })
        .eq("user_id", userId);
    return error ?? null;
}

/** Save an explicit reasoning picker choice for this authenticated profile. */
export async function persistLastSelectedReasoningLevel(
    userId: string,
    reasoningLevel: ReasoningLevel,
    db: ReturnType<typeof createServerSupabase>,
): Promise<unknown | null> {
    const { error } = await db.from("user_profiles")
        .update({ last_selected_reasoning_level: reasoningLevel, updated_at: new Date().toISOString() })
        .eq("user_id", userId);
    return error ?? null;
}

export async function getUserApiKeys(
    userId: string,
    db?: Db,
): Promise<UserApiKeys> {
    return getOrganisationApiKeys();
}
