import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";

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

  const { data, error } = await db
    .from("user_profiles")
    .select(
      "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model, fast_model, claude_api_key, gemini_api_key, openai_api_key, azure_openai_endpoint, azure_openai_api_key, azure_openai_api_version, azure_openai_deployment",
    )
    .eq("user_id", userId)
    .single();

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
    claude_api_key: data.claude_api_key,
    gemini_api_key: data.gemini_api_key,
    openai_api_key: data.openai_api_key,
    azure_openai_endpoint: data.azure_openai_endpoint,
    azure_openai_api_key: data.azure_openai_api_key,
    azure_openai_api_version: data.azure_openai_api_version,
    azure_openai_deployment: data.azure_openai_deployment,
    // Tells the frontend "the server has a shared key for this provider".
    // Lets the model dropdown show models as available even when the user
    // hasn't pasted a personal key. Actual key values never leave the
    // server. Azure OpenAI is "globally configured" once endpoint +
    // apiKey are set — deployment is no longer required because the
    // user picks one per message from the discovered list.
    global_api_keys: {
      claude: !!process.env.ANTHROPIC_API_KEY?.trim(),
      gemini: !!process.env.GEMINI_API_KEY?.trim(),
      openai: !!process.env.OPENAI_API_KEY?.trim(),
      azureOpenai:
        !!process.env.AZURE_OPENAI_ENDPOINT?.trim() &&
        !!process.env.AZURE_OPENAI_API_KEY?.trim(),
    },
  });
});

userRouter.patch("/profile", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const allowedFields = [
    "display_name",
    "organisation",
    "tabular_model",
    "fast_model",
    "claude_api_key",
    "gemini_api_key",
    "openai_api_key",
    "azure_openai_endpoint",
    "azure_openai_api_key",
    "azure_openai_api_version",
    "azure_openai_deployment",
  ] as const;

  const updates: Record<string, string | null> = {};
  for (const field of allowedFields) {
    if (field in req.body) {
      const value = req.body[field];
      updates[field] = typeof value === "string" ? value : value ?? null;
    }
  }

  if (Object.keys(updates).length === 0) {
    return void res.status(400).json({ detail: "No updatable profile fields provided" });
  }

  updates.updated_at = new Date().toISOString();

  const db = createServerSupabase();
  const { data, error } = await db
    .from("user_profiles")
    .update(updates)
    .eq("user_id", userId)
    .select(
      "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model, fast_model, claude_api_key, gemini_api_key, openai_api_key, azure_openai_endpoint, azure_openai_api_key, azure_openai_api_version, azure_openai_deployment",
    )
    .single();

  if (error) return void res.status(500).json({ detail: error.message });
  res.json(data);
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
