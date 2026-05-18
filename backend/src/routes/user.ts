import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
    getUserApiKeys,
    setUserApiKey,
    deleteUserApiKey,
} from "../lib/userApiKeys";
import type { AzureOpenaiSettings } from "../lib/llm";
import { resolveSecret } from "../lib/envSecrets";

export const userRouter = Router();

function normalizeCreditsResetDate(current: string | null): string {
  const now = new Date();
  const base = current ? new Date(current) : now;
  if (Number.isNaN(base.getTime()) || base <= now) {
    const next = new Date(now);
    next.setDate(next.getDate() + 30);
    return next.toISOString();
  }
  return base.toISOString();
}

userRouter.get("/profile", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();

  // Profile fields live on `user_profiles`; provider keys moved to the
  // encrypted `user_api_keys` table in 0006. Fetched in parallel.
  const [profileResult, apiKeys] = await Promise.all([
    db
      .from("user_profiles")
      .select(
        "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model, fast_model",
      )
      .eq("user_id", userId)
      .single(),
    getUserApiKeys(userId, db),
  ]);

  const { data, error } = profileResult;
  if (error) return void res.status(500).json({ detail: error.message });

  let messageCreditsUsed = data.message_credits_used ?? 0;
  let creditsResetDate = normalizeCreditsResetDate(data.credits_reset_date ?? null);
  const now = new Date();
  const resetDate = new Date(creditsResetDate);

  if (resetDate <= now) {
    const next = new Date(now);
    next.setDate(next.getDate() + 30);
    creditsResetDate = next.toISOString();
    messageCreditsUsed = 0;

    const { error: updateError } = await db
      .from("user_profiles")
      .update({ message_credits_used: 0, credits_reset_date: creditsResetDate })
      .eq("user_id", userId);

    if (updateError) return void res.status(500).json({ detail: updateError.message });
  }

  res.json({
    display_name: data.display_name,
    organisation: data.organisation,
    message_credits_used: messageCreditsUsed,
    credits_reset_date: creditsResetDate,
    tier: data.tier,
    tabular_model: data.tabular_model,
    fast_model: data.fast_model,
    // Backwards-compat: keep returning the plaintext provider keys so
    // the frontend's existing Account → Models form keeps working
    // through the migration. The frontend should switch to consuming
    // the *_configured booleans below and stop displaying the
    // plaintext values — at which point the plaintext fields can be
    // removed from this response in a follow-up commit. Tracked in
    // UPSTREAM_SYNC_LOG.md (ba6f771 entry).
    claude_api_key: apiKeys.claude,
    gemini_api_key: apiKeys.gemini,
    openai_api_key: apiKeys.openai,
    azure_openai_endpoint: apiKeys.azureOpenai?.endpoint ?? null,
    azure_openai_api_key: apiKeys.azureOpenai?.apiKey ?? null,
    azure_openai_api_version: apiKeys.azureOpenai?.apiVersion ?? null,
    azure_openai_deployment: apiKeys.azureOpenai?.deployment ?? null,
    // Forward-compat: per-provider configured booleans the frontend
    // should prefer once the plaintext fields above are dropped.
    claude_configured: !!apiKeys.claude,
    gemini_configured: !!apiKeys.gemini,
    openai_configured: !!apiKeys.openai,
    azure_openai_configured: !!apiKeys.azureOpenai,
    // Tells the frontend "the server has a shared key for this provider".
    // Lets the model dropdown show models as available even when the user
    // hasn't pasted a personal key. Actual key values never leave the
    // server. Azure OpenAI is "globally configured" once endpoint +
    // apiKey are set — deployment is no longer required because the
    // user picks one per message from the discovered list.
    // global_api_keys covers BOTH the env-var path (Bicep secretRef into KV
    // for anthropic + openai) AND the KV-direct path (install configurator
    // writes for gemini + azure-openai-* with no Bicep wiring). resolveSecret
    // unifies them — env first via getConfig's built-in env check, KV via
    // UAMI fallback, with the __unset__ placeholder filtered. Closes 040
    // Entry 12's availability-flag arm.
    global_api_keys: {
      claude: !!(await resolveSecret("anthropic-api-key")),
      gemini: !!(await resolveSecret("gemini-api-key")),
      openai: !!(await resolveSecret("openai-api-key")),
      azureOpenai:
        !!(await resolveSecret("azure-openai-endpoint")) &&
        !!(await resolveSecret("azure-openai-api-key")),
    },
  });
});

userRouter.patch("/profile", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();

  // Profile fields stay on `user_profiles`.
  const profileFields = [
    "display_name",
    "organisation",
    "tabular_model",
    "fast_model",
  ] as const;
  const profileUpdates: Record<string, string | null> = {};
  for (const field of profileFields) {
    if (field in req.body) {
      const value = req.body[field];
      profileUpdates[field] = typeof value === "string" ? value : value ?? null;
    }
  }

  // Provider key fields route through `userApiKeys` (encrypted at
  // rest). The request body shape is unchanged for backwards-compat;
  // we translate to setUserApiKey / deleteUserApiKey calls.
  const flatProviderFields: ReadonlyArray<{
    field: "claude_api_key" | "gemini_api_key" | "openai_api_key";
    provider: "claude" | "gemini" | "openai";
  }> = [
    { field: "claude_api_key", provider: "claude" },
    { field: "gemini_api_key", provider: "gemini" },
    { field: "openai_api_key", provider: "openai" },
  ];
  const aoaiFields = [
    "azure_openai_endpoint",
    "azure_openai_api_key",
    "azure_openai_api_version",
    "azure_openai_deployment",
  ] as const;

  const flatKeyChanges = new Map<
    "claude" | "gemini" | "openai",
    string | null
  >();
  for (const { field, provider } of flatProviderFields) {
    if (field in req.body) {
      const value = req.body[field];
      const normalised =
        typeof value === "string" && value.trim() !== "" ? value : null;
      flatKeyChanges.set(provider, normalised);
    }
  }
  const aoaiTouched = aoaiFields.some((f) => f in req.body);

  if (
    Object.keys(profileUpdates).length === 0 &&
    flatKeyChanges.size === 0 &&
    !aoaiTouched
  ) {
    return void res
      .status(400)
      .json({ detail: "No updatable profile fields provided" });
  }

  // 1. Profile updates
  if (Object.keys(profileUpdates).length > 0) {
    profileUpdates.updated_at = new Date().toISOString();
    const { error } = await db
      .from("user_profiles")
      .update(profileUpdates)
      .eq("user_id", userId);
    if (error) return void res.status(500).json({ detail: error.message });
  }

  // 2. Flat provider keys (claude, gemini, openai)
  try {
    for (const [provider, value] of flatKeyChanges) {
      if (value === null) {
        await deleteUserApiKey(userId, provider, db);
      } else {
        await setUserApiKey(userId, provider, value, db);
      }
    }
  } catch (err) {
    return void res
      .status(500)
      .json({ detail: err instanceof Error ? err.message : String(err) });
  }

  // 3. Azure OpenAI compound shape — merge changes against existing
  //    configuration so a partial PATCH (e.g., updating only the
  //    deployment) doesn't blow away the other three fields.
  if (aoaiTouched) {
    const current = await getUserApiKeys(userId, db);
    const merged: AzureOpenaiSettings = {
      endpoint:
        "azure_openai_endpoint" in req.body
          ? typeof req.body.azure_openai_endpoint === "string"
            ? req.body.azure_openai_endpoint
            : ""
          : current.azureOpenai?.endpoint ?? "",
      apiKey:
        "azure_openai_api_key" in req.body
          ? typeof req.body.azure_openai_api_key === "string" &&
            req.body.azure_openai_api_key.trim() !== ""
            ? req.body.azure_openai_api_key
            : null
          : current.azureOpenai?.apiKey ?? null,
      apiVersion:
        "azure_openai_api_version" in req.body
          ? typeof req.body.azure_openai_api_version === "string" &&
            req.body.azure_openai_api_version.trim() !== ""
            ? req.body.azure_openai_api_version
            : null
          : current.azureOpenai?.apiVersion ?? null,
      deployment:
        "azure_openai_deployment" in req.body
          ? typeof req.body.azure_openai_deployment === "string"
            ? req.body.azure_openai_deployment
            : ""
          : current.azureOpenai?.deployment ?? "",
    };

    if (!merged.endpoint && !merged.deployment) {
      // Both required fields cleared — treat as explicit delete.
      try {
        await deleteUserApiKey(userId, "azure_openai", db);
      } catch (err) {
        return void res.status(500).json({
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (merged.endpoint && merged.deployment) {
      try {
        await setUserApiKey(userId, "azure_openai", merged, db);
      } catch (err) {
        return void res.status(500).json({
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      return void res.status(400).json({
        detail:
          "Azure OpenAI requires both endpoint and deployment to be set " +
          "(or both cleared at the same time).",
      });
    }
  }

  // Re-fetch to return the canonical post-update view (same shape as GET).
  const [profileResult, apiKeys] = await Promise.all([
    db
      .from("user_profiles")
      .select(
        "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model, fast_model",
      )
      .eq("user_id", userId)
      .single(),
    getUserApiKeys(userId, db),
  ]);
  if (profileResult.error)
    return void res.status(500).json({ detail: profileResult.error.message });
  const p = profileResult.data;

  res.json({
    display_name: p.display_name,
    organisation: p.organisation,
    message_credits_used: p.message_credits_used,
    credits_reset_date: p.credits_reset_date,
    tier: p.tier,
    tabular_model: p.tabular_model,
    fast_model: p.fast_model,
    claude_api_key: apiKeys.claude,
    gemini_api_key: apiKeys.gemini,
    openai_api_key: apiKeys.openai,
    azure_openai_endpoint: apiKeys.azureOpenai?.endpoint ?? null,
    azure_openai_api_key: apiKeys.azureOpenai?.apiKey ?? null,
    azure_openai_api_version: apiKeys.azureOpenai?.apiVersion ?? null,
    azure_openai_deployment: apiKeys.azureOpenai?.deployment ?? null,
    claude_configured: !!apiKeys.claude,
    gemini_configured: !!apiKeys.gemini,
    openai_configured: !!apiKeys.openai,
    azure_openai_configured: !!apiKeys.azureOpenai,
  });
});

userRouter.post("/profile/credits/increment", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();

  const { data: current, error: readError } = await db
    .from("user_profiles")
    .select("message_credits_used")
    .eq("user_id", userId)
    .single();

  if (readError) return void res.status(500).json({ detail: readError.message });

  const nextValue = (current.message_credits_used ?? 0) + 1;
  const { error: updateError } = await db
    .from("user_profiles")
    .update({ message_credits_used: nextValue, updated_at: new Date().toISOString() })
    .eq("user_id", userId);

  if (updateError) return void res.status(500).json({ detail: updateError.message });
  res.json({ message_credits_used: nextValue });
});

// DELETE /user/account
//
// In supabase/local modes the app owns the identity, so self-service
// account closure is meaningful and cascades through every user-owned
// table.  In entra mode the identity is owned by Microsoft on the
// customer's tenant — wiping the app data while group membership still
// grants access just lets the user log back in immediately as a fresh
// account, which is misleading rather than useful.  Account closure /
// data erasure for entra tenants is handled out of band via a
// tenant-admin support ticket (to be implemented).  The frontend hides
// the button in entra mode; this guard catches anyone hitting the
// endpoint directly.
userRouter.delete("/account", requireAuth, async (_req, res) => {
  const provider = process.env.AUTH_PROVIDER ?? "supabase";
  if (provider === "entra") {
    return void res.status(403).json({
      detail:
        "Self-service account deletion is not available on Entra tenants. " +
        "Contact your tenant administrator to request account closure and " +
        "data erasure.",
    });
  }

  const userId = res.locals.userId as string;
  const userEmail = (res.locals.userEmail as string | undefined)?.toLowerCase();
  const db = createServerSupabase();

  // Order matters: delete from tables whose FKs point AT user-owned rows
  // before deleting the rows themselves.  Tables with `on delete cascade`
  // FKs are cleaned up automatically when their parent row is removed
  // (chat_messages ← chats, document_versions/edits ← documents,
  // tabular_cells/chats/messages ← tabular_reviews, project_subfolders ←
  // projects, workflow_shares ← workflows).
  async function deleteFrom(
    table: string,
    column: string,
    value: string,
  ): Promise<boolean> {
    const { error } = await db.from(table).delete().eq(column, value);
    if (error) {
      res.status(500).json({
        detail: `Failed to delete user data from ${table}: ${error.message}`,
      });
      return false;
    }
    return true;
  }

  if (!(await deleteFrom("tabular_review_chats", "user_id", userId))) return;
  if (!(await deleteFrom("chats", "user_id", userId))) return;
  if (!(await deleteFrom("tabular_reviews", "user_id", userId))) return;
  if (!(await deleteFrom("documents", "user_id", userId))) return;
  if (!(await deleteFrom("workflows", "user_id", userId))) return;
  if (!(await deleteFrom("hidden_workflows", "user_id", userId))) return;
  if (!(await deleteFrom("projects", "user_id", userId))) return;
  if (!(await deleteFrom("user_profiles", "user_id", userId))) return;

  // Clear workflow shares where this user is the recipient (by email) so
  // their email no longer grants access to anyone else's workflows.
  if (userEmail) {
    if (!(await deleteFrom("workflow_shares", "shared_with_email", userEmail)))
      return;
  }

  res.status(204).send();
});
