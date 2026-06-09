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
import {
  deleteAllUserChats,
  deleteAllUserTabularReviews,
  deleteUserAccountData,
  deleteUserProjects,
} from "../lib/userDataCleanup";
import {
  buildUserAccountExport,
  buildUserChatsExport,
  buildUserTabularReviewsExport,
  userExportFilename,
} from "../lib/userDataExport";

export const userRouter = Router();

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object") {
    const record = error as {
      message?: unknown;
      details?: unknown;
      hint?: unknown;
      code?: unknown;
    };
    return [record.message, record.details, record.hint, record.code]
      .filter((value): value is string => typeof value === "string" && !!value)
      .join(" ")
      || JSON.stringify(error);
  }
  return String(error);
}

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
    // openrouter / courtlistener (upstream 44e868e). getUserApiKeys
    // already folds in the org-level KV/env fallback for these two, so
    // "configured" means "some credential source exists".
    openrouter_configured: !!apiKeys.openrouter,
    courtlistener_configured: !!apiKeys.courtlistener,
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
      openrouter: !!(await resolveSecret("openrouter-api-key")),
      courtlistener: !!(await resolveSecret("courtlistener-api-token")),
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
    field:
      | "claude_api_key"
      | "gemini_api_key"
      | "openai_api_key"
      | "openrouter_api_key"
      | "courtlistener_api_token";
    provider: "claude" | "gemini" | "openai" | "openrouter" | "courtlistener";
  }> = [
    { field: "claude_api_key", provider: "claude" },
    { field: "gemini_api_key", provider: "gemini" },
    { field: "openai_api_key", provider: "openai" },
    // upstream 44e868e — BYO keys for the CourtListener integration
    // (and OpenRouter) ride the same encrypted user_api_keys path.
    { field: "openrouter_api_key", provider: "openrouter" },
    { field: "courtlistener_api_token", provider: "courtlistener" },
  ];
  const aoaiFields = [
    "azure_openai_endpoint",
    "azure_openai_api_key",
    "azure_openai_api_version",
    "azure_openai_deployment",
  ] as const;

  const flatKeyChanges = new Map<
    "claude" | "gemini" | "openai" | "openrouter" | "courtlistener",
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
    openrouter_configured: !!apiKeys.openrouter,
    courtlistener_configured: !!apiKeys.courtlistener,
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
  try {
    // Upstream divergence (sync-log: 3a10943): dev's previous inline
    // deleteFrom() cascade moved into lib/userDataCleanup's
    // deleteUserAccountData, which also removes the user's storage objects
    // (document/version files + the user's storage prefix) — adopted from
    // upstream.
    await deleteUserAccountData(db, userId, userEmail);

    // deleteUserAccountData stops short of identity-adjacent tables.
    // Upstream relies on Supabase's auth.users ON DELETE CASCADE to clean
    // these up; dev owns the rows, so remove them explicitly.
    for (const table of ["user_api_keys", "user_profiles"] as const) {
      const { error } = await db.from(table).delete().eq("user_id", userId);
      if (error) {
        return void res.status(500).json({
          detail: `Failed to delete user data from ${table}: ${error.message}`,
        });
      }
    }

    // Upstream calls db.auth.admin.deleteUser(userId) unconditionally. On
    // dev that API only exists in supabase mode (local mode is stateless
    // JWT with no identity table; entra never reaches this point — see the
    // guard above).
    if (provider === "supabase") {
      const { error } = await db.auth.admin.deleteUser(userId);
      if (error) return void res.status(500).json({ detail: error.message });
    }

    res.status(204).send();
  } catch (err) {
    const detail = errorMessage(err);
    console.error("[user/account] delete failed", { userId, error: detail });
    res.status(500).json({ detail });
  }
});

// Upstream divergence (sync-log: 3a10943): upstream guards the data
// deletion/export routes below with requireMfaIfEnrolled (Supabase Auth
// MFA). Dev did not adopt app-level Supabase MFA — Entra enforces MFA at
// the IdP (Conditional Access) — so these routes use requireAuth only.

// DELETE /user/chats
userRouter.delete("/chats", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  try {
    await deleteAllUserChats(db, userId);
    res.status(204).send();
  } catch (err) {
    const detail = errorMessage(err);
    console.error("[user/chats] delete failed", { userId, error: detail });
    res.status(500).json({ detail });
  }
});

// DELETE /user/projects
userRouter.delete("/projects", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  try {
    await deleteUserProjects(db, userId);
    res.status(204).send();
  } catch (err) {
    const detail = errorMessage(err);
    console.error("[user/projects] delete failed", { userId, error: detail });
    res.status(500).json({ detail });
  }
});

// DELETE /user/tabular-reviews
userRouter.delete("/tabular-reviews", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  try {
    await deleteAllUserTabularReviews(db, userId);
    res.status(204).send();
  } catch (err) {
    const detail = errorMessage(err);
    console.error("[user/tabular-reviews] delete failed", {
      userId,
      error: detail,
    });
    res.status(500).json({ detail });
  }
});

// GET /user/export
userRouter.get("/export", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const db = createServerSupabase();
  try {
    const data = await buildUserAccountExport(db, userId, userEmail);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${userExportFilename("account", userId)}"`,
    );
    res.json(data);
  } catch (err) {
    const detail = errorMessage(err);
    console.error("[user/export] failed", { userId, error: detail });
    res.status(500).json({ detail });
  }
});

// GET /user/chats/export
userRouter.get("/chats/export", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const db = createServerSupabase();
  try {
    const data = await buildUserChatsExport(db, userId, userEmail);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${userExportFilename("chats", userId)}"`,
    );
    res.json(data);
  } catch (err) {
    const detail = errorMessage(err);
    console.error("[user/chats/export] failed", { userId, error: detail });
    res.status(500).json({ detail });
  }
});

// GET /user/tabular-reviews/export
userRouter.get("/tabular-reviews/export", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const db = createServerSupabase();
  try {
    const data = await buildUserTabularReviewsExport(db, userId, userEmail);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${userExportFilename("tabular-reviews", userId)}"`,
    );
    res.json(data);
  } catch (err) {
    const detail = errorMessage(err);
    console.error("[user/tabular-reviews/export] failed", {
      userId,
      error: detail,
    });
    res.status(500).json({ detail });
  }
});
