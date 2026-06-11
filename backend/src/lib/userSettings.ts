import { createServerSupabase } from "./supabase";
import {
    resolveModel,
    DEFAULT_TITLE_MODEL,
    DEFAULT_TABULAR_MODEL,
    OPENAI_LOW_MODELS,
    type UserApiKeys,
} from "./llm";
import { getUserApiKeys as readEncryptedApiKeys } from "./userApiKeys";

export type UserModelSettings = {
    fast_model: string;
    tabular_model: string;
    legal_research_us: boolean;
    api_keys: UserApiKeys;
};

// "Fast model" = the LLM used for lightweight tasks (chat-title
// generation today, room for more). The user can pick one explicitly on
// the Account → Models page; if they haven't, we fall through a chain
// based on which providers they have keys for:
//   1. Gemini Flash Lite (cheapest)
//   2. OpenAI low tier (OPENAI_LOW_MODELS[0])
//   3. Claude Haiku
//   4. Azure OpenAI default deployment (user's stored deployment, then
//      env-level AZURE_OPENAI_DEPLOYMENT)
// With nothing configured, falls back to the Gemini default — callers
// must tolerate a "no provider available" LLM failure (chat.ts does
// this for the title route).
// Upstream divergence (sync-log: 44e868e): upstream added a stored
// title_model preference on user_profiles; dev's fast_model already
// covers that intent, so the column was not adopted.
function resolveFastModel(
    apiKeys: UserApiKeys,
    explicit: string | null | undefined,
): string {
    const pick = explicit?.trim();
    if (pick) return pick;
    if (apiKeys.gemini?.trim()) return DEFAULT_TITLE_MODEL;
    if (apiKeys.openai?.trim()) return OPENAI_LOW_MODELS[0];
    if (apiKeys.claude?.trim()) return "claude-haiku-4-5";
    const aoaiDeployment =
        apiKeys.azureOpenai?.deployment?.trim() ||
        process.env.AZURE_OPENAI_DEPLOYMENT?.trim() ||
        "";
    if (aoaiDeployment) return `aoai:${aoaiDeployment}`;
    return DEFAULT_TITLE_MODEL;
}

export async function getUserModelSettings(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserModelSettings> {
    const client = db ?? createServerSupabase();
    // Provider keys come from `user_api_keys` (encrypted, see
    // `backend/src/lib/userApiKeys.ts`); model preferences still live on
    // `user_profiles`. Issued in parallel — they're independent rows.
    const [modelRow, api_keys] = await Promise.all([
        client
            .from("user_profiles")
            .select("tabular_model, fast_model, legal_research_us")
            .eq("user_id", userId)
            .single(),
        readEncryptedApiKeys(userId, client),
    ]);
    return {
        fast_model: resolveFastModel(api_keys, modelRow.data?.fast_model),
        tabular_model: resolveModel(
            modelRow.data?.tabular_model,
            DEFAULT_TABULAR_MODEL,
        ),
        // Upstream (3132e04) folded legal_research_us into
        // getUserModelSettings (replacing the standalone
        // getLegalResearchUsEnabled helper); same default-true semantics,
        // applied in dev's parallel-query idiom.
        legal_research_us:
            (modelRow.data as { legal_research_us?: boolean | null } | null)
                ?.legal_research_us !== false,
        api_keys,
    };
}

export async function getUserApiKeys(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserApiKeys> {
    return readEncryptedApiKeys(userId, db ?? createServerSupabase());
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
    //   2a. New user → INSERT with email + display_name from the IdP.
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
            .insert({
                user_id: userId,
                email: lowercaseEmail,
                display_name: seedDisplayName,
            });
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
