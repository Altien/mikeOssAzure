import { isSupportedOpenCodeGoModel } from "../lib/llm/models";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { resolveVercelApiKey, getUserApiKeys } from "../lib/userApiKeys";
import { resolveSecret, resolveProviderSecret } from "../lib/envSecrets";
import { recordAudit } from "../lib/audit";
import { sendInternalError } from "../lib/httpError";
import { DEFAULT_TABULAR_MODEL, resolveModel } from "../lib/llm/models";
import {
  completeUserMcpConnectorOAuth,
  createUserMcpConnector,
  deleteUserMcpConnector,
  getUserMcpConnector,
  listUserMcpConnectors,
  McpOAuthRequiredError,
  refreshUserMcpConnectorTools,
  setUserMcpToolEnabled,
  startUserMcpConnectorOAuth,
  updateUserMcpConnector,
} from "../lib/mcpConnectors";
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
import { findProfileUserByEmail } from "../lib/userLookup";
import {
    getAllUserRouterModels,
    replaceUserRouterModels,
    ROUTER_SLUGS,
    type RouterModelSelections,
    type RouterSlug,
} from "../lib/routerModels";

export const userRouter = Router();

const ORGANISATION_CREDENTIALS = {
  claude: {
    label: "Anthropic",
    secretNames: ["anthropic-api-key"],
  },
  gemini: {
    label: "Gemini",
    secretNames: ["gemini-api-key"],
  },
  openai: {
    label: "OpenAI",
    secretNames: ["openai-api-key"],
  },
  kimi: {
    label: "Kimi K3",
    secretNames: ["moonshot-api-key"],
  },
  openrouter: {
    label: "OpenRouter",
    secretNames: ["openrouter-api-key"],
  },
  "opencode-go": { label: "OpenCode Go", secretNames: ["opencode-api-key"] },
  vercel: { label: "Vercel AI Gateway", secretNames: ["ai-gateway-api-key"] },
  courtlistener: {
    label: "CourtListener",
    secretNames: ["courtlistener-api-token"],
  },
  azure_openai: {
    label: "Azure OpenAI",
    secretNames: ["azure-openai-endpoint", "azure-openai-api-key"],
  },
} as const;

type OrganisationCredentialProvider = keyof typeof ORGANISATION_CREDENTIALS;

function organisationCredentialRequired(
  res: import("express").Response,
  provider: OrganisationCredentialProvider,
): void {
  const credential = ORGANISATION_CREDENTIALS[provider];
  res.status(403).json({
    code: "organisation_api_key_required",
    detail:
      `${credential.label} credentials are managed once per organisation. ` +
      "Ask an administrator to open /install and configure the organisation " +
      `credential (Key Vault secret: ${credential.secretNames.join(" and ")}).`,
  });
}

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

// GET /user/lookup?email=person@example.com
//
// Upstream route (dropped by the a5fe6d6 "conflict→ours" resolution, restored
// in OSS-6 step A; consumed by PeopleModal / AddUserInput). Any signed-in user
// may learn whether an email has a profile and its display name — accepted as
// upstream ships it (OSS-6 decision 11, single-tenant deployment).
// Dev divergence: the lookup is wrapped in try/catch because Express 4 does
// not route rejected async handlers to the error middleware — an escaped
// rejection from findProfileUserByEmail would hang the request.
userRouter.get("/lookup", requireAuth, async (req, res) => {
  const email = typeof req.query.email === "string" ? req.query.email : "";
  if (!email.trim()) {
    return void res.status(400).json({ detail: "email is required" });
  }

  try {
    const db = createServerSupabase();
    const user = await findProfileUserByEmail(db, email);
    res.json({
      exists: !!user,
      email: user?.email ?? email.trim().toLowerCase(),
      display_name: user?.display_name ?? null,
    });
  } catch (err) {
    // findProfileUserByEmail rethrows the raw Supabase/PostgREST error
    // object, which is not guaranteed to be an Error instance.
    const message = (err as { message?: unknown } | null)?.message;
    const detail = typeof message === "string" ? message : "User lookup failed";
    res.status(500).json({ detail });
  }
});

// ---------------------------------------------------------------------------
// /user/profile — upstream's camelCase wire shape (`UserProfile` +
// `apiKeyStatus`, upstream 204d2d53), so the frontend and the word add-in use
// upstream's client unchanged (OSS-6, internal design notes §3.0).
// Upstream divergence (OSS-6), kept on the server side of that shape:
//   - The title/suggestion model lives in dev's `fast_model` column (upstream
//     `title_model`, not adopted — sync-log 44e868e). `titleModel` maps to it;
//     "" means "no preference" (getUserModelSettings then picks the cheapest
//     configured model) where upstream resolves a fallback id here.
//   - Credentials are organisation-level (Key Vault primary, env fallback):
//     `apiKeyStatus` reports them with source "env"; key values never leave
//     the backend, and PATCH rejects credential fields with 403.
//   - No app-level MFA (sync-log 3a10943): `mfaOnLogin` is always false.
//   - Dev's credits-reset normalisation (normalizeCreditsResetDate).
// ---------------------------------------------------------------------------

const MONTHLY_CREDIT_LIMIT = 999999;

const PROFILE_SELECT =
  "display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas, onboarding_version, password_set_at, message_credits_used, credits_reset_date, tier, tabular_model, fast_model, legal_research_us, quick_actions_visible";
const PROFILE_SELECT_NO_PASSWORD =
  "display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas, onboarding_version, message_credits_used, credits_reset_date, tier, tabular_model, fast_model, legal_research_us, quick_actions_visible";
const PROFILE_SELECT_NO_QUICK_ACTIONS =
  "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model, fast_model, legal_research_us";
const PROFILE_SELECT_BEFORE_ONBOARDING =
  "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model, fast_model, legal_research_us, quick_actions_visible";

type UserProfileRow = {
  display_name: string | null;
  organisation: string | null;
  jurisdiction?: string | null;
  practice_setting?: string | null;
  professional_title?: string | null;
  practice_areas?: string[] | null;
  onboarding_version?: number | null;
  password_set_at?: string | null;
  message_credits_used: number | null;
  credits_reset_date: string | null;
  tier: string | null;
  tabular_model: string | null;
  fast_model: string | null;
  legal_research_us: boolean | null;
  quick_actions_visible: boolean | null;
};

type ProfileApiKeyStatus = Record<OrganisationCredentialProvider, boolean> & {
  sources: Record<OrganisationCredentialProvider, "user" | "env" | null>;
};

// Organisation secret first (source "env" = Key Vault/env); a legacy
// per-user row (pre-organisation-keys deployments) reports source "user".
async function buildProfileApiKeyStatus(
  userId: string,
  db: ReturnType<typeof createServerSupabase>,
): Promise<ProfileApiKeyStatus> {
  const userKeys = await getUserApiKeys(userId, db);
  const userConfigured: Record<OrganisationCredentialProvider, boolean> = {
    claude: !!userKeys.claude,
    gemini: !!userKeys.gemini,
    openai: !!userKeys.openai,
    kimi: !!userKeys.kimi,
    openrouter: !!userKeys.openrouter,
    vercel: !!userKeys.vercel,
    "opencode-go": !!userKeys["opencode-go"],
    courtlistener: !!userKeys.courtlistener,
    azure_openai: !!userKeys.azureOpenai,
  };
  const providers = Object.keys(
    ORGANISATION_CREDENTIALS,
  ) as OrganisationCredentialProvider[];
  const status = {} as Record<OrganisationCredentialProvider, boolean>;
  const sources = {} as ProfileApiKeyStatus["sources"];
  for (const provider of providers) {
    const values = await Promise.all(
      ORGANISATION_CREDENTIALS[provider].secretNames.map((name) =>
        (provider === "openrouter" || provider === "opencode-go") ? resolveProviderSecret(name) : resolveSecret(name),
      ),
    );
    const organisation = provider === "vercel" ? !!(await resolveVercelApiKey()) : values.every(Boolean);
    const source = organisation ? "env" : userConfigured[provider] ? "user" : null;
    status[provider] = source !== null;
    sources[provider] = source;
  }
  return { ...status, sources };
}

const CATALOG_MODEL_ID_RE = /^[^\s/]+\/[^\s]+$/;

/**
 * A router's catalog-id shape. OpenRouter and Vercel publish vendor/model
 * pairs; OpenCode Go publishes bare model names ("glm-5"), so requiring a
 * slash there would reject its entire catalog.
 */
const ROUTER_MODEL_ID_RE: Record<RouterSlug, RegExp> = {
    openrouter: CATALOG_MODEL_ID_RE,
    vercel: CATALOG_MODEL_ID_RE,
    "opencode-go": /^[^\s]+$/,
};

/**
 * The profile field each router's selection is read from and written to.
 * Mirrored by the frontend's updateUserProfile payload.
 */
export const ROUTER_PROFILE_FIELDS: Record<RouterSlug, string> = {
    openrouter: "openRouterModels",
    vercel: "vercelModels",
    "opencode-go": "openCodeGoModels",
};

export function normalizeRouterModels(
    value: unknown,
    provider: RouterSlug,
): string[] {
    if (!Array.isArray(value)) return [];
    const models: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        if (typeof item !== "string") continue;
        const trimmed = item.trim();
        // Strip a leading router slug ("openrouter/deepseek/deepseek-v3" →
        // "deepseek/deepseek-v3") only when what remains is still a full
        // vendor/model catalog id. Some catalog ids legitimately begin with
        // the router's own slug (OpenRouter's "openrouter/auto", Vercel's
        // "vercel/v0-1.5-md"); for those the raw id IS the canonical form
        // and stripping would destroy it.
        const catalogIdRe = ROUTER_MODEL_ID_RE[provider];
        const stripped = trimmed.replace(new RegExp(`^${provider}/`), "");
        const model = catalogIdRe.test(stripped) ? stripped : trimmed;
        if (
            !model ||
            model.length > 200 ||
            !catalogIdRe.test(model) ||
            (provider === "opencode-go" &&
                !isSupportedOpenCodeGoModel(model)) ||
            seen.has(model)
        ) {
            continue;
        }
        seen.add(model);
        models.push(model);
        if (models.length === 50) break;
    }
    return models;
}

function serializeProfile(
  row: UserProfileRow,
  credits: { used: number; resetDate: string },
  apiKeyStatus: ProfileApiKeyStatus,
  routerModels: RouterModelSelections,
) {
  const titleModel = row.fast_model?.trim()
    ? resolveModel(row.fast_model.trim(), "")
    : "";
  return {
    displayName: row.display_name,
    organisation: row.organisation,
    jurisdiction: row.jurisdiction ?? null,
    practiceSetting: row.practice_setting ?? null,
    professionalTitle: row.professional_title ?? null,
    practiceAreas: Array.isArray(row.practice_areas) ? row.practice_areas : [],
    onboardingComplete: row.onboarding_version === undefined || row.onboarding_version !== null,
    onboardingVersion: row.onboarding_version === undefined ? 0 : row.onboarding_version,
    passwordSet: row.password_set_at ? true : null,
    messageCreditsUsed: credits.used,
    creditsResetDate: credits.resetDate,
    creditsRemaining: Math.max(MONTHLY_CREDIT_LIMIT - credits.used, 0),
    tier: row.tier || "Free",
    titleModel,
    tabularModel: resolveModel(row.tabular_model, DEFAULT_TABULAR_MODEL),
    mfaOnLogin: false,
    // Features > Legal Research > Jurisdiction > US toggle (upstream
    // 1fa0554); defaults to enabled.
    legalResearchUs: row.legal_research_us !== false,
    quickActionsVisible: row.quick_actions_visible !== false,
    apiKeyStatus,
    ...Object.fromEntries(ROUTER_SLUGS.map(slug => [ROUTER_PROFILE_FIELDS[slug], routerModels[slug]])),
  };
}

async function loadProfile(
  db: ReturnType<typeof createServerSupabase>,
  userId: string,
): Promise<
  | { data: ReturnType<typeof serializeProfile>; error: null }
  | { data: null; error: { message: string } }
> {
  const [profileResult, apiKeyStatus] = await Promise.all([
    (async () => {
      const current = await db.from("user_profiles").select(PROFILE_SELECT).eq("user_id", userId).single();
      if (!current.error || current.error.code !== "42703") return current;
      const noPassword = await db.from("user_profiles").select(PROFILE_SELECT_NO_PASSWORD).eq("user_id", userId).single();
      if (!noPassword.error) return noPassword;
      if (noPassword.error.code !== "42703") return noPassword;
      const preOnboarding = await db.from("user_profiles").select(PROFILE_SELECT_BEFORE_ONBOARDING).eq("user_id", userId).single();
      if (!preOnboarding.error) return preOnboarding;
      if (preOnboarding.error.code !== "42703") return preOnboarding;
      const previous = await db.from("user_profiles").select(PROFILE_SELECT_NO_QUICK_ACTIONS).eq("user_id", userId).single();
      if (previous.data) {
        return { ...previous, data: { ...previous.data, quick_actions_visible: true } };
      }
      return previous;
    })(),
    buildProfileApiKeyStatus(userId, db),
  ]);
  const { data, error } = profileResult;
  if (error) return { data: null, error };
  const row = data as UserProfileRow;

  let messageCreditsUsed = row.message_credits_used ?? 0;
  let creditsResetDate = normalizeCreditsResetDate(row.credits_reset_date ?? null);
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

    if (updateError) return { data: null, error: updateError };
  }

  try {
  const routerModels = await getAllUserRouterModels(userId, db);
  return {
    data: serializeProfile(
      row,
      { used: messageCreditsUsed, resetDate: creditsResetDate },
      apiKeyStatus,
      routerModels,
    ),
    error: null,
  };
  } catch (error) { return { data: null, error: { message: errorMessage(error) } }; }
}

type ProfileUpdate = {
  display_name?: string | null;
  organisation?: string | null;
  jurisdiction?: string | null;
  practice_setting?: string | null;
  professional_title?: string | null;
  practice_areas?: string[];
  fast_model?: string | null;
  tabular_model?: string;
  legal_research_us?: boolean;
  quick_actions_visible?: boolean;
  updated_at: string;
};

const PRACTICE_SETTINGS = new Set(["private_practice", "in_house", "not_practising"]);
const PROFESSIONAL_TITLES = new Set([
  "Partner", "Senior Associate", "Associate", "Law Clerk", "Counsel",
  "General Counsel", "Legal Counsel", "Other",
]);
function normalizeProfessionalTitle(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return undefined;
  const title = value.trim();
  return PROFESSIONAL_TITLES.has(title) ? title : undefined;
}
function normalizePracticeAreas(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) return null;
  const areas = Array.from(new Set((value as string[]).map(item => item.trim()).filter(Boolean)));
  return areas.length <= 20 && areas.every(item => item.length <= 100) ? areas : null;
}

// Upstream's validateProfilePayload; `titleModel` writes dev's `fast_model`
// and accepts "" (= no preference, stored as null).
function validateProfilePayload(
  body: unknown,
): { ok: true; update: ProfileUpdate; routerModels?: Partial<Record<RouterSlug, string[]>> } | { ok: false; detail: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, detail: "Expected a JSON object" };
  }

  const raw = body as Record<string, unknown>;
  const allowedFields = new Set([
    "displayName",
    "organisation",
    "jurisdiction",
    "practiceSetting",
    "professionalTitle",
    "practiceAreas",
    "titleModel",
    "tabularModel",
    "legalResearchUs",
    "quickActionsVisible",
    ...ROUTER_SLUGS.map(slug => ROUTER_PROFILE_FIELDS[slug]),
  ]);
  const invalidField = Object.keys(raw).find((key) => !allowedFields.has(key));
  if (invalidField) {
    return { ok: false, detail: `Unsupported profile field: ${invalidField}` };
  }

  const update: ProfileUpdate = { updated_at: new Date().toISOString() };

  if ("displayName" in raw) {
    if (raw.displayName !== null && typeof raw.displayName !== "string") {
      return { ok: false, detail: "displayName must be a string or null" };
    }
    const displayName = raw.displayName?.trim() || null;
    if (displayName && displayName.length > 200) return { ok: false, detail: "displayName must be 200 characters or fewer" };
    update.display_name = displayName;
  }

  if ("organisation" in raw) {
    if (raw.organisation !== null && typeof raw.organisation !== "string") {
      return { ok: false, detail: "organisation must be a string or null" };
    }
    const organisation = raw.organisation?.trim() || null;
    if (organisation && organisation.length > 200) return { ok: false, detail: "organisation must be 200 characters or fewer" };
    update.organisation = organisation;
  }

  if ("jurisdiction" in raw) {
    if (raw.jurisdiction === null || raw.jurisdiction === "") update.jurisdiction = null;
    else if (typeof raw.jurisdiction === "string" && raw.jurisdiction.trim().length > 0 && raw.jurisdiction.trim().length <= 100)
      update.jurisdiction = raw.jurisdiction.trim();
    else return { ok: false, detail: "Select a valid jurisdiction" };
  }
  if ("practiceSetting" in raw) {
    if (raw.practiceSetting === null || raw.practiceSetting === "") update.practice_setting = null;
    else if (typeof raw.practiceSetting === "string" && PRACTICE_SETTINGS.has(raw.practiceSetting.trim()))
      update.practice_setting = raw.practiceSetting.trim();
    else return { ok: false, detail: "Select a valid professional setting" };
  }
  if ("professionalTitle" in raw) {
    const title = normalizeProfessionalTitle(raw.professionalTitle);
    if (title === undefined) return { ok: false, detail: "Select a valid title" };
    update.professional_title = title;
  }
  if ("practiceAreas" in raw) {
    const areas = normalizePracticeAreas(raw.practiceAreas);
    if (!areas) return { ok: false, detail: "Select no more than 20 valid practice areas" };
    update.practice_areas = areas;
  }

  if ("tabularModel" in raw) {
    if (typeof raw.tabularModel !== "string") {
      return { ok: false, detail: "tabularModel must be a string" };
    }
    const resolved = resolveModel(raw.tabularModel, "");
    if (!resolved) return { ok: false, detail: "Unsupported tabularModel" };
    update.tabular_model = resolved;
  }

  if ("titleModel" in raw) {
    if (typeof raw.titleModel !== "string") {
      return { ok: false, detail: "titleModel must be a string" };
    }
    if (!raw.titleModel.trim()) {
      update.fast_model = null;
    } else {
      const resolved = resolveModel(raw.titleModel.trim(), "");
      if (!resolved) return { ok: false, detail: "Unsupported titleModel" };
      update.fast_model = resolved;
    }
  }

  if ("legalResearchUs" in raw) {
    if (typeof raw.legalResearchUs !== "boolean") {
      return { ok: false, detail: "legalResearchUs must be a boolean" };
    }
    update.legal_research_us = raw.legalResearchUs;
  }

  if ("quickActionsVisible" in raw) {
    if (typeof raw.quickActionsVisible !== "boolean") {
      return { ok: false, detail: "quickActionsVisible must be a boolean" };
    }
    update.quick_actions_visible = raw.quickActionsVisible;
  }

  const routerModels: Partial<Record<RouterSlug, string[]>> = {};
    for (const slug of ROUTER_SLUGS) {
        const field = ROUTER_PROFILE_FIELDS[slug];
        if (!(field in raw)) continue;
        const value = raw[field];
        if (!Array.isArray(value)) {
            return {
                ok: false,
                detail: `${field} must be an array of model IDs`,
            };
        }
        // Check the cap before normalizing: normalizeRouterModels truncates
        // at 50, so a longer payload would otherwise surface as the
        // misleading "invalid or duplicate model ID".
        if (value.length > 50) {
            return {
                ok: false,
                detail: `${field} can include at most 50 models`,
            };
        }
        const models = normalizeRouterModels(value, slug);
        if (models.length !== value.length) {
            return {
                ok: false,
                detail: `${field} contains an invalid or duplicate model ID`,
            };
        }
        routerModels[slug] = models;
    }

  return { ok: true, update, routerModels };
}

// GET /user/profile
userRouter.get("/profile", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { data, error } = await loadProfile(db, userId);
  if (error) return void res.status(500).json({ detail: error.message });
  res.json(data);
});

userRouter.patch("/profile", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;

  const credentialFields: ReadonlyArray<{
    field: string;
    provider: OrganisationCredentialProvider;
  }> = [
    { field: "claude_api_key", provider: "claude" },
    { field: "gemini_api_key", provider: "gemini" },
    { field: "openai_api_key", provider: "openai" },
    { field: "kimi_api_key", provider: "kimi" },
    { field: "openrouter_api_key", provider: "openrouter" },
    { field: "vercel_api_key", provider: "vercel" },
    { field: "opencode_api_key", provider: "opencode-go" },
    { field: "courtlistener_api_token", provider: "courtlistener" },
    { field: "azure_openai_endpoint", provider: "azure_openai" },
    { field: "azure_openai_api_key", provider: "azure_openai" },
    { field: "azure_openai_api_version", provider: "azure_openai" },
    { field: "azure_openai_deployment", provider: "azure_openai" },
  ];
  // Dev divergence: personal credential fields (dev's old snake_case client)
  // get the explicit organisation-credential 403, not a generic 400.
  const body: Record<string, unknown> =
    req.body && typeof req.body === "object" ? req.body : {};
  const attemptedCredential = credentialFields.find(
    ({ field }) => field in body,
  );
  if (attemptedCredential) {
    return void organisationCredentialRequired(
      res,
      attemptedCredential.provider,
    );
  }

  const parsed = validateProfilePayload(req.body);
  if (!parsed.ok) return void res.status(400).json({ detail: parsed.detail });

  const db = createServerSupabase();
  const { error: updateError } = await db
    .from("user_profiles")
    .update(parsed.update)
    .eq("user_id", userId);
  if (updateError)
    return void res.status(500).json({ detail: updateError.message });

    for (const slug of ROUTER_SLUGS) {
        const models = parsed.routerModels?.[slug];
        if (models === undefined) continue;
        try {
            await replaceUserRouterModels(userId, slug, models, db);
        } catch (routerModelsError) {
            return void res.status(500).json({
                detail: errorMessage(routerModelsError),
            });
        }
    }

  // Re-fetch to return the canonical post-update view (same shape as GET).
  const { data, error } = await loadProfile(db, userId);
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

// ---------------------------------------------------------------------------
// Provider credentials are deployment-wide in MikeOssAzure. Every user shares
// the same backend and the same Key Vault-backed integrations; ordinary users
// may choose models/features but must never own or replace provider secrets.
const API_KEY_PROVIDERS = Object.keys(ORGANISATION_CREDENTIALS) as OrganisationCredentialProvider[];
type ApiKeyRouteProvider = (typeof API_KEY_PROVIDERS)[number];

// Build the read-only organisation status the frontend expects. "env" is kept
// as the wire value for compatibility, but means "organisation Key Vault/env
// credential" rather than a literal .env file.
async function buildApiKeyStatus(
  _userId: string,
  _db: ReturnType<typeof createServerSupabase>,
): Promise<Record<string, boolean | Record<string, "user" | "env" | null>>> {
  const status: Record<string, boolean> = {};
  const sources: Record<string, "user" | "env" | null> = {};
  for (const provider of API_KEY_PROVIDERS) {
    const credential = ORGANISATION_CREDENTIALS[provider];
    const values = await Promise.all(
      credential.secretNames.map((name) =>
        (provider === "openrouter" || provider === "opencode-go") ? resolveProviderSecret(name) : resolveSecret(name)),
    );
    const configured = provider === "vercel" ? !!(await resolveVercelApiKey()) : values.every(Boolean);
    status[provider] = configured;
    sources[provider] = configured ? "env" : null;
  }
  return { ...status, sources };
}

// GET /user/api-keys — which providers have a credential, and from where.
userRouter.get("/api-keys", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  res.json(await buildApiKeyStatus(userId, createServerSupabase()));
});

// PUT remains as an explicit compatibility failure for older frontends. It
// must never silently accept a personal key in an organisation deployment.
userRouter.put("/api-keys/:provider", requireAuth, async (req, res) => {
  const provider = req.params.provider as ApiKeyRouteProvider;
  if (!API_KEY_PROVIDERS.includes(provider)) {
    return void res
      .status(400)
      .json({ detail: `Unknown API key provider: ${req.params.provider}` });
  }
  organisationCredentialRequired(res, provider);
});

// ---------------------------------------------------------------------------
// MCP connectors (upstream sync 9a1277b — "feat: add mcp connectors").
//
// Adopted in dev's idiom. Two divergences from upstream's user.ts:
//
//   1. requireMfaIfEnrolled middleware dropped. Upstream guards the write
//      routes with Supabase-Auth app-level MFA (requireMfaIfEnrolled). Dev
//      did not adopt app-level Supabase MFA — Entra enforces MFA at the IdP
//      via Conditional Access (same decision recorded for the account
//      deletion/export routes below, sync-log 3a10943). These routes use
//      requireAuth only.
//   2. The encryption secret behind the connector auth material is resolved
//      from Key Vault (internal design notes §2.4) inside lib/mcp/client.ts,
//      not from raw process.env as upstream did.
//
// The popup/CSP/url helpers below are copied verbatim from upstream's
// user.ts (they have no Supabase-auth coupling).
// ---------------------------------------------------------------------------

function backendPublicUrl(req: {
    protocol: string;
    get(name: string): string | undefined;
}) {
    return (
        process.env.API_PUBLIC_URL ||
        process.env.BACKEND_URL ||
        `${req.protocol}://${req.get("host")}`
    ).replace(/\/+$/, "");
}

function frontendUrl(path = "/settings/connectors") {
    const base = (process.env.FRONTEND_URL ?? "http://localhost:3000").replace(
        /\/+$/,
        "",
    );
    return `${base}${path}`;
}

function shortHash(value: string) {
    return value
        ? crypto.createHash("sha256").update(value).digest("hex").slice(0, 12)
        : null;
}

function mcpOAuthPopupHtml(payload: {
    success: boolean;
    connectorId?: string;
    detail?: string;
}, nonce: string) {
    const targetOrigin = new URL(frontendUrl()).origin;
    const targetUrl = frontendUrl();
    const message = JSON.stringify({
        type: "mcp_oauth_result",
        ...payload,
    });
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MCP authorization</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; background: #f9fafb; }
      main { max-width: 360px; padding: 24px; text-align: center; }
      p { color: #6b7280; }
    </style>
  </head>
  <body>
    <main>
      <h1>${payload.success ? "Authorization complete" : "Authorization failed"}</h1>
      <p>${payload.success ? "You can return to Mike." : "Return to Mike and try connecting again."}</p>
    </main>
    <script nonce="${nonce}">
      const message = ${message};
      const targetUrl = ${JSON.stringify(targetUrl)};
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(message, ${JSON.stringify(targetOrigin)});
      }
      setTimeout(() => window.close(), ${payload.success ? 600 : 2500});
      ${
          payload.success
              ? "setTimeout(() => window.location.assign(targetUrl), 1000);"
              : ""
      }
    </script>
  </body>
</html>`;
}

function mcpOAuthPopupCsp(nonce: string) {
    return [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        "style-src 'unsafe-inline'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
    ].join("; ");
}

function readBooleanBodyField(
    body: unknown,
    field: string,
): { ok: true; value: boolean } | { ok: false; detail: string } {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { ok: false, detail: "Expected a JSON object" };
    }

    const raw = body as Record<string, unknown>;
    const invalidField = Object.keys(raw).find((key) => key !== field);
    if (invalidField) {
        return { ok: false, detail: `Unsupported field: ${invalidField}` };
    }
    if (typeof raw[field] !== "boolean") {
        return { ok: false, detail: `${field} must be a boolean` };
    }

    return { ok: true, value: raw[field] };
}

// Onboarding is application profile state for every admitted identity provider.
userRouter.post("/onboarding", requireAuth, async (req, res) => {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown> : null;
  if (!body || Object.keys(body).some(key => !["jurisdiction", "practiceSetting", "professionalTitle", "practiceAreas"].includes(key))) {
    return void res.status(400).json({ detail: "Invalid onboarding fields" });
  }
  const update: ProfileUpdate = { updated_at: new Date().toISOString() };
  if ("jurisdiction" in body) {
    const jurisdiction = typeof body.jurisdiction === "string" ? body.jurisdiction.trim() : "";
    if (!jurisdiction || jurisdiction.length > 100) return void res.status(400).json({ detail: "Select a valid jurisdiction" });
    update.jurisdiction = jurisdiction;
  }
  if ("practiceSetting" in body) {
    const setting = typeof body.practiceSetting === "string" ? body.practiceSetting.trim() : "";
    if (!PRACTICE_SETTINGS.has(setting)) return void res.status(400).json({ detail: "Select a valid professional setting" });
    update.practice_setting = setting;
  }
  if ("professionalTitle" in body) {
    const title = normalizeProfessionalTitle(body.professionalTitle);
    if (title === undefined) return void res.status(400).json({ detail: "Select a valid title" });
    update.professional_title = title;
  }
  if ("practiceAreas" in body) {
    const areas = normalizePracticeAreas(body.practiceAreas);
    if (!areas) return void res.status(400).json({ detail: "Select no more than 20 valid practice areas" });
    update.practice_areas = areas;
  }
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { data: profile, error: profileError } = await db.from("user_profiles")
    .select("display_name").eq("user_id", userId).single();
  if (profileError) return void sendInternalError(res, profileError);
  if (!profile || typeof profile.display_name !== "string" || !profile.display_name.trim()) {
    return void res.status(400).json({ detail: "Add your name before completing onboarding" });
  }
  const { error: updateError } = await db.from("user_profiles")
    .update({ ...update, onboarding_version: 1 })
    .eq("user_id", userId);
  if (updateError) return void sendInternalError(res, updateError);
  const { data, error } = await loadProfile(db, userId);
  if (error) return void sendInternalError(res, error);
  res.json(data);
});

// The backend performs the password mutation through the authenticated
// provider before recording its capability. An arbitrary browser assertion
// cannot mark an account as password-enabled.
userRouter.post("/security/password-set", requireAuth, async (req, res) => {
  if (process.env.AUTH_PROVIDER?.toLowerCase() !== "supabase") {
    return void res.status(403).json({ detail: "Password management is owned by your sign-in provider." });
  }
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown> : null;
  if (!body || Object.keys(body).some(key => key !== "password") ||
      typeof body.password !== "string" || body.password.length < 10 || body.password.length > 1024) {
    return void res.status(400).json({ detail: "Enter a password of 10 to 1024 characters." });
  }
  const authUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  if (!authUrl || !serviceKey) return void res.status(503).json({ detail: "Password management is unavailable." });
  const userId = res.locals.userId as string;
  try {
    const provider = createClient(authUrl, serviceKey, { auth: { persistSession: false } });
    const { data, error } = await provider.auth.admin.updateUserById(userId, { password: body.password });
    if (error || data.user?.id !== userId) {
      return void res.status(502).json({ detail: "The sign-in provider could not update the password." });
    }
    const db = createServerSupabase();
    const { error: markerError } = await db.from("user_profiles")
      .update({ password_set_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("user_id", userId);
    if (markerError) return void sendInternalError(res, markerError);
    const { data: profile, error: profileError } = await loadProfile(db, userId);
    if (profileError) return void sendInternalError(res, profileError);
    res.json(profile);
  } catch (error) {
    sendInternalError(res, error);
  }
});

// GET /user/mcp-connectors
userRouter.get("/mcp-connectors", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    try {
        res.json(
            await listUserMcpConnectors(userId, db, { includeTools: false }),
        );
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/mcp-connectors] list failed", {
            userId,
            error: detail,
        });
        sendInternalError(res, err);
    }
});

// GET /user/mcp-connectors/:connectorId
userRouter.get(
    "/mcp-connectors/:connectorId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        try {
            res.json(
                await getUserMcpConnector(userId, req.params.connectorId, db),
            );
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/mcp-connectors] get failed", {
                userId,
                connectorId: req.params.connectorId,
                error: detail,
            });
            res.status(404).json({ detail: "Connector not found" });
        }
    },
);

// POST /user/mcp-connectors
userRouter.post(
    "/mcp-connectors",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const name = typeof req.body?.name === "string" ? req.body.name : "";
        const serverUrl =
            typeof req.body?.serverUrl === "string" ? req.body.serverUrl : "";
        const bearerToken =
            typeof req.body?.bearerToken === "string"
                ? req.body.bearerToken
                : null;
        const headers =
            req.body?.headers &&
            typeof req.body.headers === "object" &&
            !Array.isArray(req.body.headers)
                ? (req.body.headers as Record<string, unknown>)
                : undefined;
        const db = createServerSupabase();
        try {
            const connector = await createUserMcpConnector(
                userId,
                { name, serverUrl, bearerToken, headers },
                db,
            );
            res.status(201).json(connector);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/mcp-connectors] create failed", {
                userId,
                error: detail,
            });
            res.status(400).json({
                detail: "Connector settings are invalid or the server could not be reached.",
            });
        }
    },
);

// PATCH /user/mcp-connectors/:connectorId
userRouter.patch(
    "/mcp-connectors/:connectorId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        const body = req.body ?? {};
        try {
            const connector = await updateUserMcpConnector(
                userId,
                req.params.connectorId,
                {
                    ...(typeof body.name === "string"
                        ? { name: body.name }
                        : {}),
                    ...(typeof body.serverUrl === "string"
                        ? { serverUrl: body.serverUrl }
                        : {}),
                    ...(typeof body.enabled === "boolean"
                        ? { enabled: body.enabled }
                        : {}),
                    ...("bearerToken" in body
                        ? {
                              bearerToken:
                                  typeof body.bearerToken === "string"
                                      ? body.bearerToken
                                      : null,
                          }
                        : {}),
                    ...("headers" in body
                        ? {
                              headers:
                                  body.headers &&
                                  typeof body.headers === "object" &&
                                  !Array.isArray(body.headers)
                                      ? (body.headers as Record<
                                            string,
                                            unknown
                                        >)
                                      : {},
                          }
                        : {}),
                },
                db,
            );
            res.json(connector);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/mcp-connectors] update failed", {
                userId,
                connectorId: req.params.connectorId,
                error: detail,
            });
            res.status(400).json({
                detail: "Connector settings are invalid or the server could not be reached.",
            });
        }
    },
);

// DELETE /user/mcp-connectors/:connectorId
userRouter.delete(
    "/mcp-connectors/:connectorId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        try {
            await deleteUserMcpConnector(userId, req.params.connectorId, db);
            res.status(204).send();
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/mcp-connectors] delete failed", {
                userId,
                connectorId: req.params.connectorId,
                error: detail,
            });
            sendInternalError(res, err);
        }
    },
);

// POST /user/mcp-connectors/:connectorId/oauth/start
userRouter.post(
    "/mcp-connectors/:connectorId/oauth/start",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        try {
            // Must include the /api prefix: this router is mounted at
            // /api/user (index.ts), so the callback lives at
            // /api/user/mcp-connectors/oauth/callback. Without /api the
            // provider redirects to a path that misses the API router, falls
            // through to the SPA catch-all, and bounces to /login.
            const redirectUri = `${backendPublicUrl(req)}/api/user/mcp-connectors/oauth/callback`;
            const result = await startUserMcpConnectorOAuth(
                userId,
                req.params.connectorId,
                redirectUri,
                db,
            );
            res.json(result);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/mcp-connectors] oauth start failed", {
                userId,
                connectorId: req.params.connectorId,
                error: detail,
            });
            res.status(400).json({
                detail: "Connector authorization could not be started.",
            });
        }
    },
);

// GET /user/mcp-connectors/oauth/callback
userRouter.get("/mcp-connectors/oauth/callback", async (req, res) => {
    const nonce = crypto.randomBytes(16).toString("base64");
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const error =
        typeof req.query.error === "string" ? req.query.error : undefined;
    const db = createServerSupabase();
    try {
        if (error) throw new Error(error);
        if (!state || !code)
            throw new Error("OAuth callback is missing state or code.");
        const result = await completeUserMcpConnectorOAuth(state, code, db);
        res.set("Content-Security-Policy", mcpOAuthPopupCsp(nonce))
            // Override helmet's global COOP (same-origin): this popup MUST keep
            // window.opener to postMessage the result back to the app. When the
            // frontend and backend are different origins (e.g. dev :3000/:3001),
            // same-origin COOP severs the opener and the parent only sees the
            // popup close ("OAuth authorization window was closed").
            .set("Cross-Origin-Opener-Policy", "unsafe-none")
            .type("html")
            .send(
                mcpOAuthPopupHtml(
                    {
                        success: true,
                        connectorId: result.connectorId,
                    },
                    nonce,
                ),
            );
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/mcp-connectors] oauth callback failed", {
            error: detail,
            stateHash: shortHash(state),
            hasCode: !!code,
            hasError: !!error,
            issuer:
                typeof req.query.iss === "string" ? req.query.iss : undefined,
            scope:
                typeof req.query.scope === "string"
                    ? req.query.scope
                    : undefined,
        });
        res.status(400)
            .set("Content-Security-Policy", mcpOAuthPopupCsp(nonce))
            // Same reason as the success branch: the failure popup also
            // postMessages its result to the opener.
            .set("Cross-Origin-Opener-Policy", "unsafe-none")
            .type("html")
            .send(
                mcpOAuthPopupHtml(
                    {
                        success: false,
                        detail: "Connector authorization could not be completed.",
                    },
                    nonce,
                ),
            );
    }
});

// POST /user/mcp-connectors/:connectorId/refresh-tools
userRouter.post(
    "/mcp-connectors/:connectorId/refresh-tools",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerSupabase();
        try {
            const connector = await refreshUserMcpConnectorTools(
                userId,
                req.params.connectorId,
                db,
            );
            res.json(connector);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/mcp-connectors] refresh failed", {
                userId,
                connectorId: req.params.connectorId,
                error: detail,
            });
            if (err instanceof McpOAuthRequiredError) {
                // 428 (not 401): this is the MCP *provider* needing OAuth, not
                // the user's Mike session expiring. A 401 here would be caught
                // by the frontend's bounceIfUnauthorized and force a spurious
                // logout, swallowing the `oauth_required` code the connectors
                // page needs to launch the OAuth popup. See docs/tests/
                // 07-mcp-connectors.md and matches the MFA pattern (403 + code).
                return void res.status(428).json({
                    code: err.code,
                    detail: "This connector needs to be authorized again.",
                });
            }
            res.status(400).json({
                detail: "Connector tools could not be refreshed.",
            });
        }
    },
);

// PATCH /user/mcp-connectors/:connectorId/tools/:toolId
userRouter.patch(
    "/mcp-connectors/:connectorId/tools/:toolId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const parsed = readBooleanBodyField(req.body, "enabled");
        if (!parsed.ok)
            return void res.status(400).json({ detail: parsed.detail });

        const db = createServerSupabase();
        try {
            const connector = await setUserMcpToolEnabled(
                userId,
                req.params.connectorId,
                req.params.toolId,
                parsed.value,
                db,
            );
            res.json(connector);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/mcp-connectors] tool toggle failed", {
                userId,
                connectorId: req.params.connectorId,
                toolId: req.params.toolId,
                error: detail,
            });
            res.status(400).json({
                detail: "Connector tool settings could not be updated.",
            });
        }
    },
);

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
    void recordAudit(createServerSupabase(), {
      userId,
      userEmail,
      action: "export.account",
      surface: "account",
    });
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
    void recordAudit(createServerSupabase(), {
      userId,
      userEmail,
      action: "export.chats",
      surface: "account",
    });
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
    void recordAudit(createServerSupabase(), {
      userId,
      userEmail,
      action: "export.tabular",
      surface: "account",
    });
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
