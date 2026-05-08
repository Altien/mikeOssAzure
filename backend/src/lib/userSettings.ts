import { createServerSupabase } from "./supabase";
import {
    resolveModel,
    DEFAULT_TITLE_MODEL,
    DEFAULT_TABULAR_MODEL,
    type UserApiKeys,
    type AzureOpenaiSettings,
} from "./llm";

export type UserModelSettings = {
    fast_model: string;
    tabular_model: string;
    api_keys: UserApiKeys;
};

// "Fast model" = the LLM used for lightweight tasks (chat-title
// generation today, room for more). The user can pick one explicitly on
// the Account → Models page; if they haven't, we fall through a chain
// based on which providers they have keys for:
//   1. Gemini Flash Lite (cheapest)
//   2. OpenAI gpt-5-nano
//   3. Claude Haiku
//   4. Azure OpenAI default deployment (user's stored deployment, then
//      env-level AZURE_OPENAI_DEPLOYMENT)
// With nothing configured, falls back to the Gemini default — callers
// must tolerate a "no provider available" LLM failure (chat.ts does
// this for the title route).
function resolveFastModel(
    apiKeys: UserApiKeys,
    explicit: string | null | undefined,
): string {
    const pick = explicit?.trim();
    if (pick) return pick;
    if (apiKeys.gemini?.trim()) return DEFAULT_TITLE_MODEL;
    if (apiKeys.openai?.trim()) return "gpt-5-nano";
    if (apiKeys.claude?.trim()) return "claude-haiku-4-5";
    const aoaiDeployment =
        apiKeys.azureOpenai?.deployment?.trim() ||
        process.env.AZURE_OPENAI_DEPLOYMENT?.trim() ||
        "";
    if (aoaiDeployment) return `aoai:${aoaiDeployment}`;
    return DEFAULT_TITLE_MODEL;
}

function buildAzureOpenaiSettings(row: {
    azure_openai_endpoint?: string | null;
    azure_openai_api_key?: string | null;
    azure_openai_api_version?: string | null;
    azure_openai_deployment?: string | null;
} | null): AzureOpenaiSettings | null {
    if (!row) return null;
    const endpoint = row.azure_openai_endpoint?.trim();
    const deployment = row.azure_openai_deployment?.trim();
    // Endpoint + deployment are the minimum for the adapter to attempt a
    // call. apiKey is left optional here — the adapter throws a clear
    // error if it's missing (until MI auth lands).
    if (!endpoint || !deployment) return null;
    return {
        endpoint,
        deployment,
        apiKey: row.azure_openai_api_key ?? null,
        apiVersion: row.azure_openai_api_version ?? null,
    };
}

export async function getUserModelSettings(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserModelSettings> {
    const client = db ?? createServerSupabase();
    const { data } = await client
        .from("user_profiles")
        .select(
            "tabular_model, fast_model, claude_api_key, gemini_api_key, openai_api_key, azure_openai_endpoint, azure_openai_api_key, azure_openai_api_version, azure_openai_deployment",
        )
        .eq("user_id", userId)
        .single();

    const api_keys: UserApiKeys = {
        claude: data?.claude_api_key ?? null,
        gemini: data?.gemini_api_key ?? null,
        openai: data?.openai_api_key ?? null,
        azureOpenai: buildAzureOpenaiSettings(data ?? null),
    };

    return {
        fast_model: resolveFastModel(api_keys, data?.fast_model),
        tabular_model: resolveModel(data?.tabular_model, DEFAULT_TABULAR_MODEL),
        api_keys,
    };
}

export async function getUserApiKeys(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserApiKeys> {
    const client = db ?? createServerSupabase();
    const { data } = await client
        .from("user_profiles")
        .select(
            "claude_api_key, gemini_api_key, openai_api_key, azure_openai_endpoint, azure_openai_api_key, azure_openai_api_version, azure_openai_deployment",
        )
        .eq("user_id", userId)
        .single();
    return {
        claude: data?.claude_api_key ?? null,
        gemini: data?.gemini_api_key ?? null,
        openai: data?.openai_api_key ?? null,
        azureOpenai: buildAzureOpenaiSettings(data ?? null),
    };
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
