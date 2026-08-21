import { createServerSupabase } from "./supabase";
import {
    resolveModel,
    DEFAULT_TITLE_MODEL,
    DEFAULT_TABULAR_MODEL,
    OPENAI_LOW_MODELS,
    type UserApiKeys,
} from "./llm";
import { getOrganisationApiKeys } from "./userApiKeys";
import {
    getAllUserRouterModels,
    isRouterModelSelected,
    ROUTER_SLUGS,
    routerForModelId,
    type RouterModelSelections,
} from "./routerModels";

export type UserModelSettings = {
    fast_model: string;
    tabular_model: string;
    legal_research_us: boolean;
    api_keys: UserApiKeys;
    personalisation?: {
        displayName: string | null;
        organisation: string | null;
        jurisdiction: string | null;
        practiceSetting: string | null;
        professionalTitle: string | null;
        practiceAreas: string[];
    };
};

// Title generation is a lightweight task — always routed to the cheapest model
// of whichever provider the user has keys for: Gemini Flash Lite if Gemini is
// available, otherwise OpenAI lite, Claude Haiku, or the user's first saved
// router model. With no usable provider, defaults to Gemini (the dev-mode env
// fallback).
function resolveTitleModel(
    apiKeys: UserApiKeys,
    routerModels: RouterModelSelections,
): string {
    if (apiKeys.gemini?.trim()) return DEFAULT_TITLE_MODEL;
    if (apiKeys.openai?.trim()) return OPENAI_LOW_MODELS[0];
    if (apiKeys.claude?.trim()) return "claude-haiku-4-5";
    if (apiKeys.kimi?.trim()) return "kimi-k3";
    const deployment = apiKeys.azureOpenai?.deployment?.trim() || process.env.AZURE_OPENAI_DEPLOYMENT?.trim();
    if (deployment) return `aoai:${deployment}`;
    for (const slug of ROUTER_SLUGS) {
        const first = routerModels[slug][0];
        if (apiKeys[slug]?.trim() && first) return `${slug}/${first}`;
    }
    return DEFAULT_TITLE_MODEL;
}

export async function getUserModelSettings(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserModelSettings> {
    const client = db ?? createServerSupabase();
    const [profileResult, api_keys, routerModels] = await Promise.all([
        client
            .from("user_profiles")
            .select("fast_model, tabular_model, legal_research_us, display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas")
            .eq("user_id", userId)
            .single(),
        getOrganisationApiKeys(),
        getAllUserRouterModels(userId, client),
    ]);
    const data = profileResult.data;

    // A stored preference can name a router model the user has since removed
    // from (or never had in) their saved selection — e.g. a hand-crafted
    // profile PATCH. Treat that exactly like an invalid model id and fall
    // back, so the env-key spend path can't be steered onto arbitrary
    // gateway models.
    const guardRouterModel = (model: string, fallback: string): string => {
        if (
            !routerForModelId(model) ||
            isRouterModelSelected(model, routerModels)
        ) {
            return model;
        }
        console.warn(
            `[router-models] user ${userId} preference "${model}" is outside their saved selection; using ${fallback}`,
        );
        return fallback;
    };
    const titleFallback = resolveTitleModel(api_keys, routerModels);

    return {
        fast_model: guardRouterModel(
            resolveModel(data?.fast_model?.trim(), titleFallback),
            titleFallback,
        ),
        tabular_model: guardRouterModel(
            resolveModel(data?.tabular_model, DEFAULT_TABULAR_MODEL),
            DEFAULT_TABULAR_MODEL,
        ),
        legal_research_us:
            (data as { legal_research_us?: boolean | null } | null)
                ?.legal_research_us !== false,
        personalisation: {
            displayName:
                typeof data?.display_name === "string"
                    ? data.display_name
                    : null,
            organisation:
                typeof data?.organisation === "string"
                    ? data.organisation
                    : null,
            jurisdiction:
                typeof data?.jurisdiction === "string"
                    ? data.jurisdiction
                    : null,
            practiceSetting:
                typeof data?.practice_setting === "string"
                    ? data.practice_setting
                    : null,
            professionalTitle:
                typeof data?.professional_title === "string"
                    ? data.professional_title
                    : null,
            practiceAreas: Array.isArray(data?.practice_areas)
                ? data.practice_areas.filter(
                      (area): area is string => typeof area === "string",
                  )
                : [],
        },
        api_keys,
    };
}

export async function getUserApiKeys(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserApiKeys> {
    return getOrganisationApiKeys();
}

export async function upsertUserProfile(
    userId: string,
    email?: string | null,
    displayName?: string | null,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<void> {
    const client = db ?? createServerSupabase();
    const lowercaseEmail = email?.trim().toLowerCase() || null;
    const seedDisplayName = displayName?.trim() || null;

    // Two-phase to keep IdP-provided display names from clobbering whatever
    // a user has typed into their Account page:
    //   1. SELECT the existing row (if any) — we need to know whether
    //      display_name is currently null, which is the back-fill condition.
    //   2a. New user → conflict-safe INSERT with email + display_name from the
    //       IdP. Several first-page requests run concurrently, so every caller
    //       can observe the row as missing. Ignore a duplicate user_id here;
    //       the winning request inserted the same authenticated principal.
    //   2b. Returning user → UPDATE email always (IdP is source of truth);
    //       only update display_name when the existing value is null.
    const { data: existing, error: selectError } = await client
        .from("user_profiles")
        .select("email, display_name")
        .eq("user_id", userId)
        .maybeSingle();
    if (selectError) {
        throw new Error(`Failed to read user profile: ${selectError.message}`);
    }

    if (!existing) {
        const { error: insertError } = await client
            .from("user_profiles")
            .upsert(
                {
                    user_id: userId,
                    email: lowercaseEmail,
                    display_name: seedDisplayName,
                },
                {
                    onConflict: "user_id",
                    ignoreDuplicates: true,
                },
            );
        if (insertError) {
            throw new Error(
                `Failed to create user profile: ${insertError.message}`,
            );
        }
        return;
    }

    const updates: Record<string, string | null> = {};
    if ((existing.email as string | null) !== lowercaseEmail) {
        updates.email = lowercaseEmail;
    }
    if (
        seedDisplayName &&
        ((existing.display_name as string | null) ?? "").trim() === ""
    ) {
        updates.display_name = seedDisplayName;
    }

    if (Object.keys(updates).length === 0) return;

    const { error: updateError } = await client
        .from("user_profiles")
        .update(updates)
        .eq("user_id", userId);
    if (updateError) {
        throw new Error(`Failed to update user profile: ${updateError.message}`);
    }
}
