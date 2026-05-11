// One-shot migration: encrypts every user's plaintext provider keys
// from `user_profiles` into `user_api_keys`, then NULLs the legacy
// columns once the encrypted rows are in. Idempotent — re-running sees
// no rows to migrate.
//
// Trigger: `npm run migrate:user-api-keys` (or :dev). Run AFTER
// `0006_user_api_keys.sql` has been applied; required BEFORE
// `0007_drop_legacy_provider_keys.sql` lands.
//
// See `backend/migrations/UPSTREAM_SYNC_LOG.md` (ba6f771 entry) for the
// surrounding sequence and `notes/upstream-sync/mikeOssOrig-ba6f771.md`
// in MikeMigrate for full migration narrative.

import { createServerSupabase } from "../lib/supabase.js";
import { setUserApiKey } from "../lib/userApiKeys.js";

type LegacyRow = {
    user_id: string;
    claude_api_key: string | null;
    gemini_api_key: string | null;
    openai_api_key: string | null;
    azure_openai_endpoint: string | null;
    azure_openai_api_key: string | null;
    azure_openai_api_version: string | null;
    azure_openai_deployment: string | null;
};

type UserOutcome = {
    user_id: string;
    migrated: string[];
    failed: { provider: string; reason: string }[];
};

async function main(): Promise<void> {
    const db = createServerSupabase();

    // Find every user_profiles row with any plaintext provider key set.
    // The `.or()` filter on null-checks lets PostgREST narrow the read
    // server-side rather than us scanning everyone.
    const { data: rows, error } = await db
        .from("user_profiles")
        .select(
            "user_id, claude_api_key, gemini_api_key, openai_api_key, azure_openai_endpoint, azure_openai_api_key, azure_openai_api_version, azure_openai_deployment",
        )
        .or(
            "claude_api_key.not.is.null,gemini_api_key.not.is.null,openai_api_key.not.is.null,azure_openai_endpoint.not.is.null",
        );

    if (error) {
        console.error("[migrate-user-api-keys] failed to read user_profiles", error);
        process.exit(1);
    }

    const candidates = (rows ?? []) as LegacyRow[];
    console.log(
        `[migrate-user-api-keys] ${candidates.length} user(s) have plaintext keys to migrate`,
    );

    const outcomes: UserOutcome[] = [];
    for (const row of candidates) {
        outcomes.push(await migrateOneUser(row, db));
    }

    // Summary
    const totalProvidersMigrated = outcomes.reduce(
        (n, o) => n + o.migrated.length,
        0,
    );
    const totalFailures = outcomes.reduce((n, o) => n + o.failed.length, 0);
    console.log(
        `[migrate-user-api-keys] done. users=${outcomes.length} ` +
            `providers_migrated=${totalProvidersMigrated} failures=${totalFailures}`,
    );
    if (totalFailures > 0) {
        console.error(
            `[migrate-user-api-keys] ${totalFailures} provider migration(s) failed; ` +
                `the affected users' legacy columns were NOT cleared. ` +
                `Re-run after fixing the underlying cause.`,
        );
        for (const o of outcomes) {
            if (o.failed.length === 0) continue;
            for (const f of o.failed) {
                console.error(`  user=${o.user_id} provider=${f.provider} reason=${f.reason}`);
            }
        }
        process.exit(2);
    }
}

async function migrateOneUser(
    row: LegacyRow,
    db: ReturnType<typeof createServerSupabase>,
): Promise<UserOutcome> {
    const outcome: UserOutcome = {
        user_id: row.user_id,
        migrated: [],
        failed: [],
    };
    const updates: Partial<LegacyRow> = {};

    // Three flat providers: claude, gemini, openai
    for (const provider of ["claude", "gemini", "openai"] as const) {
        const column = `${provider}_api_key` as const;
        const value = row[column];
        if (!value) continue;
        try {
            await setUserApiKey(row.user_id, provider, value, db);
            outcome.migrated.push(provider);
            // Mark for clear, but don't actually clear until all of this
            // user's providers have been processed and we know they all
            // succeeded (or we'd half-empty the row on partial failure).
            updates[column] = null;
        } catch (err) {
            outcome.failed.push({
                provider,
                reason: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // Azure OpenAI — compound shape. Needs endpoint + deployment at minimum.
    const aoaiEndpoint = row.azure_openai_endpoint?.trim();
    const aoaiDeployment = row.azure_openai_deployment?.trim();
    if (aoaiEndpoint && aoaiDeployment) {
        try {
            await setUserApiKey(
                row.user_id,
                "azure_openai",
                {
                    endpoint: aoaiEndpoint,
                    deployment: aoaiDeployment,
                    apiKey: row.azure_openai_api_key ?? null,
                    apiVersion: row.azure_openai_api_version ?? null,
                },
                db,
            );
            outcome.migrated.push("azure_openai");
            updates.azure_openai_endpoint = null;
            updates.azure_openai_api_key = null;
            updates.azure_openai_api_version = null;
            updates.azure_openai_deployment = null;
        } catch (err) {
            outcome.failed.push({
                provider: "azure_openai",
                reason: err instanceof Error ? err.message : String(err),
            });
        }
    } else if (aoaiEndpoint || row.azure_openai_api_key || aoaiDeployment) {
        // Partial AOAI config — endpoint + deployment must both be set to
        // satisfy the buildAzureOpenaiSettings precondition. Skip with a
        // note rather than failing the run.
        console.warn(
            `[migrate-user-api-keys] user=${row.user_id} azure_openai partial config (missing endpoint or deployment); skipping`,
        );
    }

    // Only clear the legacy columns if every provider this user had
    // succeeded. Partial failures leave the row untouched so a re-run can
    // pick up where we left off.
    if (outcome.failed.length === 0 && Object.keys(updates).length > 0) {
        const { error: updateError } = await db
            .from("user_profiles")
            .update(updates)
            .eq("user_id", row.user_id);
        if (updateError) {
            outcome.failed.push({
                provider: "<clear-legacy-columns>",
                reason: updateError.message,
            });
        }
    }

    console.log(
        `[migrate-user-api-keys] user=${row.user_id} migrated=[${outcome.migrated.join(",")}] failed=[${outcome.failed.map((f) => f.provider).join(",")}]`,
    );
    return outcome;
}

main().catch((err) => {
    console.error("[migrate-user-api-keys] unhandled error", err);
    process.exit(1);
});
