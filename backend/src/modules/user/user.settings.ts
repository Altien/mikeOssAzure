import { createServerSupabase, type Db } from "../../lib/supabase";
import { DEFAULT_TITLE_MODEL, OPENAI_LOW_MODELS, type UserApiKeys, type ReasoningLevel } from "../../lib/llm";
import { getEffectiveApiKeys, loadCourtListenerConnection } from "./user.apiKeyStore";
import { courtlistenerBulkDataEnabled } from "../../lib/courtlistener";
import { loadCustomInstructions } from "./user.customInstructions";
import {
    DEFAULT_RESPONSE_STYLE,
    loadResponseStyle,
    type ResponseStyle,
} from "./user.responseStyle";
import { loadWebSearchSettings } from "./user.webSearch";
import { DEFAULT_WEB_SEARCH_SETTINGS, type WebSearchSettings } from "../../lib/webSearch";
import { safeError } from "../../lib/safeError";
import { getEffectiveRouterModels, ROUTER_SLUGS, type RouterModelSelections } from "../../lib/routerModels";
import { normalizeOptionalModelPreference, normalizeReasoningLevel } from "../../lib/modelSelection";
import { AppError } from "../../lib/appError";
import { reportError } from "../../lib/observability/sentry";

export type UserModelSettings = {
    /** Existing internal title helper for Altien skill paths. */
    fast_model: string;
    /** Explicit title override stored in Dev's fast_model; null derives from chat model. */
    title_model: string | null;
    tabular_model: string | null;
    /** Explicit override for asynchronous memory curation. */
    memory_curator_model: string | null;
    /** Told to the assistant as defaults for its subagents; never enforced. */
    subagent_model: string | null;
    subagent_reasoning: ReasoningLevel | null;
    /** Cross-surface fallback used only when a chat has no usable model. */
    last_selected_chat_model: string | null;
    last_selected_reasoning_level: ReasoningLevel | null;
    /**
     * Whether the assistant gets the CourtListener tools: the user's switch is
     * on and the connector is usable, through a saved token or the
     * deployment's bulk index.
     */
    legal_research_us: boolean;
    web_search: WebSearchSettings;
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

/**
 * `options.orgId` is the organization the work belongs to, when it belongs
 * to one: the keys it runs on are then the organization's, with a member's
 * own keys beneath them only if the organization allows that (see
 * getEffectiveApiKeys), and the saved model preferences are judged against
 * the lists that govern those keys (getEffectiveRouterModels). Everything
 * else here is the person's own, whichever workspace they are in.
 */
/**
 * A settings read that fell back to its default. The chat goes ahead, so this
 * is a warning; the failed query is the cause so its code still extracts, and
 * the same object is logged once (the console bridge knows it is reported).
 */
function reportSettingsReadFailure(message: string, error: unknown): void {
    const failure = new AppError("db.query_failed", message, { cause: error });
    reportError(failure, { level: "warning" });
    console.error(`[user-settings] ${message}`, safeError(failure));
}

export async function getUserModelSettings(
    userId: string,
    db?: Db,
    options: { orgId?: string | null } = {},
): Promise<UserModelSettings> {
    const client = db ?? createServerSupabase();
    const [
        profileResult,
        api_keys,
        routerModels,
        customInstructions,
        responseStyle,
        webSearch,
        courtListener,
    ] = await Promise.all([
        client
            .from("user_profiles")
            .select(
                "fast_model, tabular_model, memory_curator_model, subagent_model, subagent_reasoning, last_selected_chat_model, last_selected_reasoning_level, legal_research_us, display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas",
            )
            .eq("user_id", userId)
            .single(),
        getEffectiveApiKeys(userId, options.orgId, client),
        getEffectiveRouterModels(userId, options.orgId, client),
        // Instructions are an enhancement: a failed read must not block chat.
        loadCustomInstructions(client, userId).catch((error: unknown) => {
            reportSettingsReadFailure("custom instructions load failed", error);
            return "";
        }),
        loadResponseStyle(client, userId).catch((error: unknown) => {
            reportSettingsReadFailure("response style load failed", error);
            return DEFAULT_RESPONSE_STYLE;
        }),
        loadWebSearchSettings(client, userId).catch((error: unknown) => {
            reportSettingsReadFailure("web search settings load failed", error);
            return DEFAULT_WEB_SEARCH_SETTINGS;
        }),
        // The CourtListener switch is per workspace, like the connector.
        // Research is an enhancement: a failed read leaves it off.
        loadCourtListenerConnection(
            { userId, orgId: options.orgId ?? null },
            client,
        ).catch((error: unknown) => {
            reportSettingsReadFailure("CourtListener connection load failed", error);
            return { enabled: false, token: null };
        }),
    ]);
    let data = profileResult.data;
    let profileError = profileResult.error;

    // Deploy-before-migrate tolerance for the subagent defaults.
    if (
        profileError?.code === "42703" &&
        typeof profileError.message === "string" &&
        profileError.message.includes("subagent_")
    ) {
        const withoutSubagentDefaults = await client
            .from("user_profiles")
            .select(
                "fast_model, tabular_model, memory_curator_model, last_selected_chat_model, last_selected_reasoning_level, legal_research_us, display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas",
            )
            .eq("user_id", userId)
            .single();
        if (!withoutSubagentDefaults.error) {
            data = {
                ...withoutSubagentDefaults.data,
                subagent_model: null,
                subagent_reasoning: null,
            } as typeof data;
            profileError = null;
        } else {
            profileError = withoutSubagentDefaults.error;
        }
    }

    // Deploy-before-migrate tolerance for the memory curator preference. Keep
    // every previously available setting while the new nullable column is
    // still being rolled out.
    if (
        profileError?.code === "42703" &&
        typeof profileError.message === "string" &&
        profileError.message.includes("memory_curator_model")
    ) {
        const withoutMemoryCuratorModel = await client
            .from("user_profiles")
            .select(
                "fast_model, tabular_model, last_selected_chat_model, last_selected_reasoning_level, legal_research_us, display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas",
            )
            .eq("user_id", userId)
            .single();
        if (!withoutMemoryCuratorModel.error) {
            data = {
                ...withoutMemoryCuratorModel.data,
                memory_curator_model: null,
            } as typeof data;
            profileError = null;
        } else {
            profileError = withoutMemoryCuratorModel.error;
        }
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
        legal_research_us: courtListener.enabled && (!!api_keys.courtlistener || courtlistenerBulkDataEnabled()),
        subagent_model: optional(data?.subagent_model),
        subagent_reasoning: normalizeReasoningLevel(data?.subagent_reasoning),
        web_search: webSearch,
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
