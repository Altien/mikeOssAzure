// @ts-nocheck
import crypto from "crypto";
import { Router } from "express";
import {
    localAuthOnly,
    requireAuth,
    requireMfaIfEnrolled,
} from "../middleware/auth";
import {
    createLocalUser,
    createSession,
    deleteSession,
    findLocalUserByEmail,
    findLocalUserById,
    findSession,
    markSessionMfaVerified,
    updateLocalUserEmail,
    verifyPassword,
} from "../lib/sqlite";
import {
    createServerDatabase,
    type ServerDatabase,
} from "../lib/database";
import {
    createMfaChallenge,
    createMfaFactor,
    hasVerifiedTotpFactor,
    listMfaFactors,
    unenrollMfaFactor,
    verifyMfaFactorCode,
} from "../lib/mfa";
import { recordAudit } from "../lib/audit";
import { sendInternalError } from "../lib/httpError";
import { sendServerError } from "../lib/safeError";
import {
    isSupportedOpenCodeGoModel,
    REASONING_LEVELS,
    resolveModel,
} from "../lib/llm";
import { configuredModelSummaries } from "../lib/llm/registry";
import {
    normalizeOptionalModelPreference,
    normalizeReasoningLevel,
} from "../lib/modelSelection";
import {
    type ApiKeyStatus,
    getUserApiKeyStatus,
    hasEnvApiKey,
    normalizeApiKeyProvider,
    saveUserApiKey,
} from "../lib/userApiKeys";
import {
    completeUserMcpConnectorOAuth,
    createUserMcpConnector,
    deleteUserMcpConnector,
    getUserMcpConnector,
    listUserMcpConnectors,
    provisionPatentMcpConnector,
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
import { configuredApiPublicUrl } from "../lib/runtimeConfig";
import {
    getUserFeatures,
    normalizeUserFeatures,
    requireUserFeature,
    USER_FEATURE_KEYS,
    type UserFeatures,
} from "../lib/userFeatures";
import { resolveDeploymentModules } from "../lib/deploymentModules";
import {
    getAllUserRouterModels,
    getUserRouterModels,
    replaceUserRouterModels,
    ROUTER_SLUGS,
    type RouterModelSelections,
    type RouterSlug,
} from "../lib/routerModels";

export const userRouter = Router();

const MONTHLY_CREDIT_LIMIT = 999999;

function publicUser(user: { id: string; email?: string | null }) {
    return { id: user.id, email: user.email ?? "", pendingEmail: null };
}

function bearerToken(req: { headers: { authorization?: string } }) {
    const auth = req.headers.authorization ?? "";
    return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email: string): boolean {
    return email.length <= 254 && EMAIL_PATTERN.test(email);
}

userRouter.post("/auth/signup", localAuthOnly, async (req, res) => {
    const email =
        typeof req.body?.email === "string" ? req.body.email.trim() : "";
    const password =
        typeof req.body?.password === "string" ? req.body.password : "";
    if (!isValidEmail(email) || password.length < 6) {
        return void res
            .status(400)
            .json({ detail: "A valid email and a 6+ character password are required" });
    }
    if (findLocalUserByEmail(email)) {
        return void res.status(409).json({ detail: "Email is already registered" });
    }
    const user = createLocalUser(email, password);
    const token = createSession(user.id);
    res.json({ token, user: publicUser(user) });
});

function profileMfaOnLogin(userId: string): boolean {
    const db = createServerDatabase();
    return db
        .from("user_profiles")
        .select("mfa_on_login")
        .eq("user_id", userId)
        .maybeSingle()
        .then(({ data }) => {
            const value = (data as { mfa_on_login?: unknown } | null)
                ?.mfa_on_login;
            return value === true || value === 1 || value === "1";
        })
        .catch(() => false);
}

userRouter.post("/auth/login", localAuthOnly, async (req, res) => {
    const email =
        typeof req.body?.email === "string" ? req.body.email.trim() : "";
    const password =
        typeof req.body?.password === "string" ? req.body.password : "";
    const row = findLocalUserByEmail(email) as
        | {
              id: string;
              email: string;
              password_hash: string;
              password_salt: string;
          }
        | null;
    if (!row || !verifyPassword(password, row.password_hash, row.password_salt)) {
        return void res.status(401).json({ detail: "Invalid email or password" });
    }
    const mfaRequired =
        hasVerifiedTotpFactor(row.id) && (await profileMfaOnLogin(row.id));
    const token = createSession(row.id, !mfaRequired);
    res.json({ token, user: publicUser(row), mfaRequired });
});

userRouter.get("/auth/session", localAuthOnly, async (req, res) => {
    const session = findSession(bearerToken(req));
    if (!session) return void res.json({ user: null });
    const user = findLocalUserById(session.userId) as
        | { id: string; email?: string }
        | null;
    res.json({ user: user ? publicUser(user) : null });
});

userRouter.post("/auth/logout", localAuthOnly, async (req, res) => {
    const token = bearerToken(req);
    if (token) deleteSession(token);
    res.status(204).send();
});

userRouter.patch("/auth/email", localAuthOnly, requireAuth, async (req, res) => {
    const email =
        typeof req.body?.email === "string" ? req.body.email.trim() : "";
    if (!isValidEmail(email)) {
        return void res.status(400).json({ detail: "A valid email is required" });
    }
    const userId = res.locals.userId as string;
    const existing = findLocalUserByEmail(email) as { id: string } | null;
    if (existing && existing.id !== userId) {
        return void res.status(409).json({ detail: "Email is already registered" });
    }
    const user = updateLocalUserEmail(userId, email);
    res.json({ user: publicUser(user) });
});

const SUPPORT_FEEDBACK_TYPES = new Set(["bug", "feature", "question", "other"]);

userRouter.post("/support", requireAuth, async (req, res) => {
    const type = typeof req.body?.type === "string" ? req.body.type : "";
    const subject = typeof req.body?.subject === "string" ? req.body.subject.trim() : "";
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const link = typeof req.body?.link === "string" ? req.body.link.trim() : "";
    if (!SUPPORT_FEEDBACK_TYPES.has(type) || !subject || !message) {
        return void res
            .status(400)
            .json({ detail: "type, subject, and message are required" });
    }
    const userId = res.locals.userId as string;
    const userEmail = (res.locals.userEmail as string) ?? "";
    const db = createServerDatabase();
    const { error } = await db.from("support_feedback").insert({
        id: crypto.randomUUID(),
        user_id: userId,
        email: userEmail,
        type,
        subject: subject.slice(0, 200),
        message: message.slice(0, 10000),
        link: link.slice(0, 2000) || null,
    });
    if (error) {
        return void res.status(500).json({ detail: "Failed to submit feedback" });
    }

    const inbox = process.env.SUPPORT_INBOX_EMAIL;
    const resendKey = process.env.RESEND_API_KEY;
    if (inbox && resendKey) {
        void (async () => {
            try {
                const { Resend } = await import("resend");
                const resend = new Resend(resendKey);
                await resend.emails.send({
                    from: process.env.SUPPORT_FROM_EMAIL ?? "Mike Support <onboarding@resend.dev>",
                    to: inbox,
                    subject: `[Mike ${type}] ${subject.slice(0, 200)}`,
                    text: `From: ${userEmail} (${userId})\nType: ${type}\nLink: ${link || "-"}\n\n${message}`,
                });
            } catch (err) {
                console.error("[user/support] email delivery failed", {
                    userId,
                    error: errorMessage(err),
                });
            }
        })();
    }
    res.status(204).send();
});

type UserProfileRow = {
    display_name: string | null;
    organisation: string | null;
    jurisdiction?: string | null;
    practice_setting?: string | null;
    professional_title?: string | null;
    practice_areas?: string[] | null;
    onboarding_version?: number | null;
    password_set_at?: string | null;
    message_credits_used: number;
    credits_reset_date: string;
    tier: string;
    title_model: string | null;
    tabular_model: string | null;
    last_selected_chat_model?: string | null;
    last_selected_reasoning_level?: string | null;
    mfa_on_login: boolean | null;
    legal_research_us: boolean | null;
    email_integration_enabled: boolean | null;
    dark_mode: boolean | null;
    feature_flags?: unknown;
    quick_actions_visible: boolean | null;
};

// GET /user/mfa/status — factors plus authenticator assurance levels.
userRouter.get("/mfa/status", localAuthOnly, requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const factors = listMfaFactors(userId).map((factor) => ({
        id: factor.id,
        friendly_name: factor.friendly_name,
        factor_type: "totp",
        status: factor.status,
        created_at: factor.created_at,
        updated_at: factor.updated_at,
    }));
    const hasVerified = factors.some((factor) => factor.status === "verified");
    const mfaVerified = res.locals.mfaVerified !== false;
    res.json({
        factors,
        currentLevel: mfaVerified ? (hasVerified ? "aal2" : "aal1") : "aal1",
        nextLevel: hasVerified ? "aal2" : "aal1",
    });
});

// POST /user/mfa/enroll — create a pending TOTP factor.
userRouter.post("/mfa/enroll", localAuthOnly, requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = (res.locals.userEmail as string) ?? "";
    const friendlyName =
        typeof req.body?.friendlyName === "string" && req.body.friendlyName.trim()
            ? req.body.friendlyName.trim().slice(0, 100)
            : "Mike";
    try {
        const result = await createMfaFactor(userId, userEmail, friendlyName);
        if ("error" in result && result.error) {
            return void res.status(400).json({ detail: result.error });
        }
        res.json({
            id: result.id,
            totp: { qr_code: result.qrCode, secret: result.secret, uri: result.uri },
        });
    } catch (err) {
        sendServerError(res, err);
    }
});

// POST /user/mfa/challenge — TOTP challenges are stateless; the client must
// present the returned challenge id when verifying.
userRouter.post("/mfa/challenge", localAuthOnly, requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const factorId = typeof req.body?.factorId === "string" ? req.body.factorId : "";
    if (!factorId) {
        return void res.status(400).json({ detail: "factorId is required" });
    }
    try {
        const challenge = createMfaChallenge(factorId, userId);
        if (!challenge) {
            return void res.status(404).json({ detail: "Factor not found" });
        }
        res.json(challenge);
    } catch (err) {
        sendServerError(res, err);
    }
});

// POST /user/mfa/verify — verify a TOTP code; confirms pending factors and
// elevates the current session to aal2.
userRouter.post("/mfa/verify", localAuthOnly, requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const factorId = typeof req.body?.factorId === "string" ? req.body.factorId : "";
    const challengeId =
        typeof req.body?.challengeId === "string" ? req.body.challengeId : undefined;
    const code = typeof req.body?.code === "string" ? req.body.code : "";
    if (!factorId || !code) {
        return void res.status(400).json({ detail: "factorId and code are required" });
    }
    try {
        const result = verifyMfaFactorCode({ factorId, userId, challengeId, code });
        if (!result.ok) {
            return void res.status(400).json({ detail: result.error });
        }
        markSessionMfaVerified(res.locals.token as string);
        res.status(204).send();
    } catch (err) {
        sendServerError(res, err);
    }
});

// POST /user/mfa/unenroll — requires an MFA-verified (aal2) session so a
// password-only session cannot disable MFA.
userRouter.post("/mfa/unenroll", localAuthOnly, requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const factorId = typeof req.body?.factorId === "string" ? req.body.factorId : "";
    if (!factorId) {
        return void res.status(400).json({ detail: "factorId is required" });
    }
    if (res.locals.mfaVerified === false) {
        return void res.status(403).json({
            detail: "Verify your authenticator before removing factors.",
            code: "mfa_verification_required",
        });
    }
    unenrollMfaFactor(factorId, userId);
    if (!hasVerifiedTotpFactor(userId)) {
        const db = createServerDatabase();
        await db
            .from("user_profiles")
            .update({ mfa_on_login: false })
            .eq("user_id", userId);
    }
    res.status(204).send();
});

function errorMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    if (error && typeof error === "object") {
        const record = error as {
            message?: unknown;
            details?: unknown;
            hint?: unknown;
            code?: unknown;
        };
        return (
            [record.message, record.details, record.hint, record.code]
                .filter(
                    (value): value is string =>
                        typeof value === "string" && !!value,
                )
                .join(" ") || JSON.stringify(error)
        );
    }
    return String(error);
}

function backendPublicUrl(req: {
    protocol: string;
    get(name: string): string | undefined;
}) {
    const configured = configuredApiPublicUrl();
    if (configured) return configured;
    if (process.env.NODE_ENV === "production") {
        throw new Error("API_PUBLIC_URL is required for connector OAuth");
    }
    const host = req.get("host");
    if (!host) throw new Error("Request host is required for connector OAuth");
    return new URL(`${req.protocol}://${host}`).origin;
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

function mcpOAuthPopupHtml(
    payload: {
        success: boolean;
        connectorId?: string;
        detail?: string;
    },
    nonce: string,
) {
    const targetOrigin = new URL(frontendUrl()).origin;
    const targetUrl = frontendUrl();
    // Escape "<" so attacker-influenced payload fields (e.g. the OAuth
    // ?error= query param echoed into `detail`) cannot break out of the
    // inline <script> block with a "</script>" sequence.
    const message = JSON.stringify({
        type: "mcp_oauth_result",
        ...payload,
    }).replace(/</g, "\\u003c");
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

const PROFILE_SELECT =
    "display_name, organisation, jurisdiction, practice_setting, professional_title, practice_areas, onboarding_version, password_set_at, message_credits_used, credits_reset_date, tier, title_model, tabular_model, last_selected_chat_model, last_selected_reasoning_level, mfa_on_login, legal_research_us, email_integration_enabled, dark_mode, feature_flags, quick_actions_visible";

// Deploy-before-migrate tolerance is per column. Retry without whichever
// optional column the database reports missing while preserving every newer
// column it does have, then supply the serialization-safe default.
const OPTIONAL_PROFILE_COLUMN_DEFAULTS: Record<string, unknown> = {
    jurisdiction: undefined,
    practice_setting: undefined,
    professional_title: undefined,
    practice_areas: undefined,
    onboarding_version: undefined,
    password_set_at: undefined,
    title_model: null,
    tabular_model: null,
    last_selected_chat_model: null,
    last_selected_reasoning_level: null,
    mfa_on_login: false,
    legal_research_us: true,
    email_integration_enabled: false,
    dark_mode: false,
    feature_flags: {},
    quick_actions_visible: true,
};

function isMissingProfileColumn(error: unknown, column: string): boolean {
    const record =
        error && typeof error === "object"
            ? (error as { code?: unknown; message?: unknown })
            : {};
    const message = typeof record.message === "string" ? record.message : "";
    return record.code === "42703" && message.includes(column);
}

// Loads a profile while tolerating older databases that lack newer preference
// columns: retries the select without each column PostgREST reports missing
// and applies that column's safe default to the returned row.
async function selectProfile(
    db: ServerDatabase,
    userId: string,
    mode: "maybe" | "single",
) {
    const columns = PROFILE_SELECT.split(", ");
    const defaults: Record<string, unknown> = {};
    while (true) {
        const query = db
            .from("user_profiles")
            .select(columns.join(", "))
            .eq("user_id", userId);
        const result =
            mode === "single"
                ? await query.single()
                : await query.maybeSingle();
        if (!result.error) {
            if (result.data && typeof result.data === "object") {
                Object.assign(result.data as Record<string, unknown>, defaults);
            }
            return result;
        }

        const missingColumn = Object.keys(
            OPTIONAL_PROFILE_COLUMN_DEFAULTS,
        ).find(
            (column) =>
                columns.includes(column) &&
                isMissingProfileColumn(result.error, column),
        );
        if (!missingColumn) return result;
        columns.splice(columns.indexOf(missingColumn), 1);
        defaults[missingColumn] = OPTIONAL_PROFILE_COLUMN_DEFAULTS[missingColumn];
    }
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
    routerModels: RouterModelSelections,
    row: UserProfileRow,
    apiKeyStatus?: ApiKeyStatus,
) {
    const creditsUsed = row.message_credits_used ?? 0;
    return {
        displayName: row.display_name,
        organisation: row.organisation,
        jurisdiction: row.jurisdiction ?? null,
        practiceSetting: row.practice_setting ?? null,
        professionalTitle: row.professional_title ?? null,
        practiceAreas: Array.isArray(row.practice_areas)
            ? row.practice_areas
            : [],
        // Databases that have not yet applied the onboarding migration must
        // not lock existing users out of the app. NULL means a new user still
        // needs onboarding; 0 identifies a legacy-exempt user; 1 is complete.
        onboardingVersion:
            row.onboarding_version === undefined
                ? 0
                : row.onboarding_version,
        onboardingComplete:
            row.onboarding_version === undefined ||
            row.onboarding_version !== null,
        passwordSet: !!row.password_set_at,
        messageCreditsUsed: creditsUsed,
        creditsResetDate: row.credits_reset_date,
        creditsRemaining: Math.max(MONTHLY_CREDIT_LIMIT - creditsUsed, 0),
        tier: row.tier || "Free",
        titleModel: normalizeOptionalModelPreference(
            row.title_model,
            routerModels,
        ),
        tabularModel: normalizeOptionalModelPreference(
            row.tabular_model,
            routerModels,
        ),
        lastSelectedChatModel: normalizeOptionalModelPreference(
            row.last_selected_chat_model,
            routerModels,
        ),
        lastSelectedReasoningLevel:
            normalizeReasoningLevel(row.last_selected_reasoning_level) ??
            "high",
        mfaOnLogin: row.mfa_on_login === true,
        legalResearchUs: row.legal_research_us !== false,
        emailIntegrationEnabled: row.email_integration_enabled === true,
        darkMode: row.dark_mode === true,
        featureFlags: normalizeUserFeatures(row.feature_flags),
        deploymentModules: resolveDeploymentModules(),
        quickActionsVisible: row.quick_actions_visible !== false,
        darkMode: row.dark_mode === true,
        ...Object.fromEntries(
            ROUTER_SLUGS.map((slug) => [
                ROUTER_PROFILE_FIELDS[slug],
                routerModels[slug],
            ]),
        ),
        ...(apiKeyStatus ? { apiKeyStatus } : {}),
    };
}

const PRACTICE_SETTINGS = new Set([
    "private_practice",
    "in_house",
    "not_practising",
]);

const PROFESSIONAL_TITLES = new Set([
    "Partner",
    "Senior Associate",
    "Associate",
    "Law Clerk",
    "Counsel",
    "General Counsel",
    "Legal Counsel",
    "Other",
]);

function isPracticeSetting(value: string): boolean {
    return PRACTICE_SETTINGS.has(value);
}

function normalizeProfessionalTitle(
    value: unknown,
): string | null | undefined {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "string") return undefined;
    const title = value.trim();
    return PROFESSIONAL_TITLES.has(title) ? title : undefined;
}

function normalizePracticeAreas(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const practiceAreas = Array.from(
        new Set(
            value
                .filter((item): item is string => typeof item === "string")
                .map((item) => item.trim())
                .filter(Boolean),
        ),
    );
    if (
        practiceAreas.length > 20 ||
        practiceAreas.some((item) => item.length > 100)
    ) {
        return null;
    }
    return practiceAreas;
}

type PersonalisationUpdate = {
    jurisdiction?: string | null;
    practice_setting?: string | null;
    professional_title?: string | null;
    practice_areas?: string[];
};

function parsePersonalisationPayload(
    raw: Record<string, unknown>,
    { allowClearing }: { allowClearing: boolean },
):
    | { ok: true; update: PersonalisationUpdate }
    | { ok: false; detail: string } {
    const update: PersonalisationUpdate = {};

    if ("jurisdiction" in raw) {
        if (
            allowClearing &&
            (raw.jurisdiction === null || raw.jurisdiction === "")
        ) {
            update.jurisdiction = null;
        } else {
            const jurisdiction =
                typeof raw.jurisdiction === "string"
                    ? raw.jurisdiction.trim()
                    : "";
            if (!jurisdiction || jurisdiction.length > 100) {
                return {
                    ok: false,
                    detail: "Select a valid jurisdiction of practice",
                };
            }
            update.jurisdiction = jurisdiction;
        }
    }

    if ("practiceSetting" in raw) {
        if (
            allowClearing &&
            (raw.practiceSetting === null || raw.practiceSetting === "")
        ) {
            update.practice_setting = null;
        } else {
            const practiceSetting =
                typeof raw.practiceSetting === "string"
                    ? raw.practiceSetting.trim()
                    : "";
            if (!isPracticeSetting(practiceSetting)) {
                return {
                    ok: false,
                    detail: "Select a valid professional setting",
                };
            }
            update.practice_setting = practiceSetting;
        }
    }

    if ("professionalTitle" in raw) {
        const professionalTitle = normalizeProfessionalTitle(
            raw.professionalTitle,
        );
        if (
            professionalTitle === undefined ||
            (!allowClearing && professionalTitle === null)
        ) {
            return { ok: false, detail: "Select a valid title" };
        }
        update.professional_title = professionalTitle;
    }

    if ("practiceAreas" in raw) {
        const practiceAreas = normalizePracticeAreas(raw.practiceAreas);
        if (!practiceAreas) {
            return {
                ok: false,
                detail: "Select no more than 20 valid practice areas",
            };
        }
        update.practice_areas = practiceAreas;
    }

    return { ok: true, update };
}

function validateProfilePayload(body: unknown):
    | {
          ok: true;
          update: {
              display_name?: string | null;
              organisation?: string | null;
              jurisdiction?: string | null;
              practice_setting?: string | null;
              professional_title?: string | null;
              practice_areas?: string[];
              title_model?: string | null;
              tabular_model?: string | null;
              last_selected_chat_model?: string | null;
              last_selected_reasoning_level?: string | null;
              legal_research_us?: boolean;
              email_integration_enabled?: boolean;
              dark_mode?: boolean;
              feature_flags?: UserFeatures;
              quick_actions_visible?: boolean;
              updated_at: string;
          };
          routerModels?: Partial<Record<RouterSlug, string[]>>;
      }
    | { ok: false; detail: string } {
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
        "lastSelectedChatModel",
        "lastSelectedReasoningLevel",
        "legalResearchUs",
        "emailIntegrationEnabled",
        "darkMode",
        "featureFlags",
        "quickActionsVisible",
        "darkMode",
        ...ROUTER_SLUGS.map((slug) => ROUTER_PROFILE_FIELDS[slug]),
    ]);
    const invalidField = Object.keys(raw).find(
        (key) => !allowedFields.has(key),
    );
    if (invalidField) {
        return {
            ok: false,
            detail: `Unsupported profile field: ${invalidField}`,
        };
    }

    const update: {
        display_name?: string | null;
        organisation?: string | null;
        jurisdiction?: string | null;
        practice_setting?: string | null;
        professional_title?: string | null;
        practice_areas?: string[];
        title_model?: string | null;
        tabular_model?: string | null;
        last_selected_chat_model?: string | null;
        last_selected_reasoning_level?: string | null;
        legal_research_us?: boolean;
        email_integration_enabled?: boolean;
        dark_mode?: boolean;
        feature_flags?: UserFeatures;
        quick_actions_visible?: boolean;
        dark_mode?: boolean;
        updated_at: string;
    } = { updated_at: new Date().toISOString() };
    const routerModels: Partial<Record<RouterSlug, string[]>> = {};

    const personalisation = parsePersonalisationPayload(raw, {
        allowClearing: true,
    });
    if (!personalisation.ok) return personalisation;
    Object.assign(update, personalisation.update);

    // Both fields flow into every chat's system prompt via
    // buildUserPersonalisationPrompt, so an unbounded value would inflate
    // token cost on every message. Truncate (not reject) at 200 characters:
    // that is exactly what the signup trigger (handle_new_user's
    // left(..., 200)) does to the same columns, and rejection would strand
    // any over-long value written before this cap existed.
    if ("displayName" in raw) {
        if (raw.displayName !== null && typeof raw.displayName !== "string") {
            return {
                ok: false,
                detail: "displayName must be a string or null",
            };
        }
        update.display_name =
            raw.displayName?.trim().slice(0, 200) || null;
    }

    if ("organisation" in raw) {
        if (raw.organisation !== null && typeof raw.organisation !== "string") {
            return {
                ok: false,
                detail: "organisation must be a string or null",
            };
        }
        update.organisation =
            raw.organisation?.trim().slice(0, 200) || null;
    }

    if ("tabularModel" in raw) {
        if (raw.tabularModel === null || raw.tabularModel === "") {
            update.tabular_model = null;
        } else if (typeof raw.tabularModel !== "string") {
            return {
                ok: false,
                detail: "tabularModel must be a string or null",
            };
        } else {
            const resolved = resolveModel(raw.tabularModel, "");
            if (!resolved) {
                return { ok: false, detail: "Unsupported tabularModel" };
            }
            update.tabular_model = resolved;
        }
    }

    if ("titleModel" in raw) {
        if (raw.titleModel === null || raw.titleModel === "") {
            update.title_model = null;
        } else if (typeof raw.titleModel !== "string") {
            return {
                ok: false,
                detail: "titleModel must be a string or null",
            };
        } else {
            const resolved = resolveModel(raw.titleModel, "");
            if (!resolved) {
                return { ok: false, detail: "Unsupported titleModel" };
            }
            update.title_model = resolved;
        }
    }

    if ("lastSelectedChatModel" in raw) {
        if (
            raw.lastSelectedChatModel === null ||
            raw.lastSelectedChatModel === ""
        ) {
            update.last_selected_chat_model = null;
        } else if (typeof raw.lastSelectedChatModel !== "string") {
            return {
                ok: false,
                detail: "lastSelectedChatModel must be a string or null",
            };
        } else {
            const resolved = resolveModel(raw.lastSelectedChatModel, "");
            if (!resolved) {
                return {
                    ok: false,
                    detail: "Unsupported lastSelectedChatModel",
                };
            }
            update.last_selected_chat_model = resolved;
        }
    }

    if ("lastSelectedReasoningLevel" in raw) {
        if (typeof raw.lastSelectedReasoningLevel !== "string") {
            return {
                ok: false,
                detail: "lastSelectedReasoningLevel must be a string",
            };
        }
        if (!(REASONING_LEVELS as readonly string[]).includes(
            raw.lastSelectedReasoningLevel,
        )) {
            return {
                ok: false,
                detail: "Unsupported lastSelectedReasoningLevel",
            };
        }
        update.last_selected_reasoning_level =
            raw.lastSelectedReasoningLevel;
    }

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

    if ("legalResearchUs" in raw) {
        if (typeof raw.legalResearchUs !== "boolean") {
            return {
                ok: false,
                detail: "legalResearchUs must be a boolean",
            };
        }
        update.legal_research_us = raw.legalResearchUs;
    }

    if ("emailIntegrationEnabled" in raw) {
        if (typeof raw.emailIntegrationEnabled !== "boolean") {
            return {
                ok: false,
                detail: "emailIntegrationEnabled must be a boolean",
            };
        }
        update.email_integration_enabled = raw.emailIntegrationEnabled;
    }

    if ("darkMode" in raw) {
        if (typeof raw.darkMode !== "boolean") {
            return {
                ok: false,
                detail: "darkMode must be a boolean",
            };
        }
        update.dark_mode = raw.darkMode;
    }

    if ("featureFlags" in raw) {
        if (
            !raw.featureFlags ||
            typeof raw.featureFlags !== "object" ||
            Array.isArray(raw.featureFlags)
        ) {
            return {
                ok: false,
                detail: "featureFlags must be an object",
            };
        }
        const flags = raw.featureFlags as Record<string, unknown>;
        const invalidFeature = Object.keys(flags).find(
            (key) =>
                !USER_FEATURE_KEYS.includes(
                    key as (typeof USER_FEATURE_KEYS)[number],
                ),
        );
        if (invalidFeature) {
            return {
                ok: false,
                detail: `Unsupported feature flag: ${invalidFeature}`,
            };
        }
        const nonBooleanFeature = Object.entries(flags).find(
            ([, value]) => typeof value !== "boolean",
        );
        if (nonBooleanFeature) {
            return {
                ok: false,
                detail: `featureFlags.${nonBooleanFeature[0]} must be a boolean`,
            };
        }
        update.feature_flags = normalizeUserFeatures(flags);
    }

    if ("quickActionsVisible" in raw) {
        if (typeof raw.quickActionsVisible !== "boolean") {
            return {
                ok: false,
                detail: "quickActionsVisible must be a boolean",
            };
        }
        update.quick_actions_visible = raw.quickActionsVisible;
    }

    if ("darkMode" in raw) {
        if (typeof raw.darkMode !== "boolean") {
            return {
                ok: false,
                detail: "darkMode must be a boolean",
            };
        }
        update.dark_mode = raw.darkMode;
    }

    return { ok: true, update, routerModels };
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

async function userHasVerifiedTotpFactor(
    db: ServerDatabase,
    userId: string,
) {
    void db;
    return {
        ok: true as const,
        hasVerifiedTotp: hasVerifiedTotpFactor(userId),
    };
}

async function ensureProfileRow(
    db: ServerDatabase,
    userId: string,
) {
    const { error } = await db
        .from("user_profiles")
        .upsert(
            { user_id: userId, email_integration_enabled: false },
            { onConflict: "user_id", ignoreDuplicates: true },
        );
    return error;
}

async function loadProfile(
    db: ServerDatabase,
    userId: string,
    options: { repairMissing?: boolean; apiKeyStatus?: ApiKeyStatus } = {},
) {
    let { data, error } = await selectProfile(db, userId, "maybe");

    if (error) return { data: null, error };
    if (!data) {
        if (!options.repairMissing) {
            return { data: null, error: new Error("Profile not found") };
        }

        const ensureError = await ensureProfileRow(db, userId);
        if (ensureError) return { data: null, error: ensureError };

        const created = await selectProfile(db, userId, "single");
        if (created.error) return { data: null, error: created.error };
        data = created.data;
    }

    let row = data as UserProfileRow;
    if (
        row.credits_reset_date &&
        new Date() > new Date(row.credits_reset_date)
    ) {
        const creditsResetDate = new Date();
        creditsResetDate.setDate(creditsResetDate.getDate() + 30);
        const { error: resetError } = await db
            .from("user_profiles")
            .update({
                message_credits_used: 0,
                credits_reset_date: creditsResetDate.toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId)
            .lt("credits_reset_date", new Date().toISOString());

        if (resetError) return { data: null, error: resetError };
        const { data: resetData, error: resetLoadError } = await selectProfile(
            db,
            userId,
            "single",
        );
        if (resetLoadError) return { data: null, error: resetLoadError };
        row = resetData as UserProfileRow;
    }

    try {
        const routerModels = await getAllUserRouterModels(userId, db);
        return {
            data: serializeProfile(routerModels, row, options.apiKeyStatus),
            error: null,
        };
    } catch (routerModelsError) {
        return {
            data: null,
            error:
                routerModelsError instanceof Error
                    ? routerModelsError
                    : new Error(errorMessage(routerModelsError)),
        };
    }
}

// POST /user/profile
userRouter.post("/profile", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerDatabase();
    const error = await ensureProfileRow(db, userId);
    if (error) return void sendInternalError(res, error);
    res.json({ ok: true });
});

// GET /user/lookup?email=person@example.com
userRouter.get("/lookup", requireAuth, async (req, res) => {
    const email = typeof req.query.email === "string" ? req.query.email : "";
    if (!email.trim()) {
        return void res.status(400).json({ detail: "email is required" });
    }

    const db = createServerDatabase();
    const user = await findProfileUserByEmail(db, email);
    res.json({
        exists: !!user,
        email: user?.email ?? email.trim().toLowerCase(),
        display_name: user?.display_name ?? null,
    });
});

// GET /user/profile
userRouter.get("/profile", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerDatabase();
    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    const { data, error } = await loadProfile(db, userId, {
        repairMissing: true,
        apiKeyStatus,
    });
    if (error) return void sendInternalError(res, error);
    res.json({ ...data, apiKeyStatus });
});

// GET /user/models
userRouter.get("/models", requireAuth, async (_req, res) => {
    const db = createServerDatabase();
    const features = await getUserFeatures(res.locals.userId as string, db);
    res.json({
        configured: configuredModelSummaries().filter(
            (model) =>
                (model.location !== "local" || features.localModels) &&
                (model.location !== "committee" || features.committeeModels),
        ),
    });
});

// PATCH /user/profile
userRouter.patch("/profile", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const parsed = validateProfilePayload(req.body);
    if (!parsed.ok) return void res.status(400).json({ detail: parsed.detail });

    const db = createServerDatabase();
    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError)
        return void sendInternalError(res, ensureError);

    const { error: updateError } = await db
        .from("user_profiles")
        .update(parsed.update)
        .eq("user_id", userId);
    if (updateError)
        return void sendInternalError(res, updateError);

    for (const slug of ROUTER_SLUGS) {
        const models = parsed.routerModels?.[slug];
        if (models === undefined) continue;
        try {
            await replaceUserRouterModels(userId, slug, models, db);
        } catch (routerModelsError) {
            return void sendInternalError(res, routerModelsError);
        }
    }

    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    const { data, error } = await loadProfile(db, userId, { apiKeyStatus });
    if (error) return void sendInternalError(res, error);
    res.json({ ...data, apiKeyStatus });
});

// POST /user/onboarding
userRouter.post("/onboarding", requireAuth, async (req, res) => {
    const body =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
            ? (req.body as Record<string, unknown>)
            : null;
    if (!body) {
        return void res.status(400).json({ detail: "Expected a JSON object" });
    }

    const invalidField = Object.keys(body).find(
        (key) =>
            key !== "jurisdiction" &&
            key !== "practiceSetting" &&
            key !== "professionalTitle" &&
            key !== "practiceAreas",
    );
    if (invalidField) {
        return void res.status(400).json({
            detail: `Unsupported onboarding field: ${invalidField}`,
        });
    }

    const personalisation = parsePersonalisationPayload(body, {
        allowClearing: false,
    });
    if (!personalisation.ok) {
        return void res.status(400).json({ detail: personalisation.detail });
    }
    const personalisationUpdate = personalisation.update;

    const userId = res.locals.userId as string;
    const db = createServerDatabase();
    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError) {
        return void res.status(500).json({ detail: ensureError.message });
    }

    const { error: updateError } = await db
        .from("user_profiles")
        .update({
            ...personalisationUpdate,
            onboarding_version: 1,
            updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
    if (updateError) {
        return void res.status(500).json({ detail: updateError.message });
    }

    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    const { data, error } = await loadProfile(db, userId, { apiKeyStatus });
    if (error) return void res.status(500).json({ detail: error.message });
    res.json({ ...data, apiKeyStatus });
});

// POST /user/security/password-set
// Record password capability only after verifying Supabase's auth.users row.
userRouter.post("/security/password-set", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerDatabase();
    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError) {
        return void res.status(500).json({ detail: ensureError.message });
    }

    const { data: passwordSetAt, error: syncError } = await db.rpc(
        "sync_user_password_set",
        { p_user_id: userId },
    );
    if (syncError) {
        return void res.status(500).json({ detail: syncError.message });
    }
    if (!passwordSetAt) {
        return void res.status(409).json({
            detail: "Supabase has not recorded a password for this account",
        });
    }

    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    const { data, error } = await loadProfile(db, userId, { apiKeyStatus });
    if (error) return void sendServerError(res, error);
    res.json({ ...data, apiKeyStatus });
});

// PATCH /user/security/mfa-login
userRouter.patch(
    "/security/mfa-login",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const parsed = readBooleanBodyField(req.body, "enabled");
        if (!parsed.ok)
            return void res.status(400).json({ detail: parsed.detail });

        const db = createServerDatabase();
        if (parsed.value) {
            const factorCheck = await userHasVerifiedTotpFactor(db, userId);
            if (!factorCheck.ok) {
                return void sendInternalError(res, factorCheck.error);
            }
            if (!factorCheck.hasVerifiedTotp) {
                return void res.status(400).json({
                    detail: "Set up an authenticator app before requiring verification on login.",
                });
            }
        }

        const ensureError = await ensureProfileRow(db, userId);
        if (ensureError)
            return void sendInternalError(res, ensureError);

        const { error: updateError } = await db
            .from("user_profiles")
            .update({
                mfa_on_login: parsed.value,
                updated_at: new Date().toISOString(),
            })
            .eq("user_id", userId);
        if (updateError)
            return void sendInternalError(res, updateError);

        const apiKeyStatus = await getUserApiKeyStatus(userId, db);
        const { data, error } = await loadProfile(db, userId, { apiKeyStatus });
        if (error) return void sendInternalError(res, error);
        res.json({ ...data, apiKeyStatus });
    },
);

// GET /user/api-keys
userRouter.get("/api-keys", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerDatabase();
    const status = await getUserApiKeyStatus(userId, db);
    res.json(status);
});

// PUT /user/api-keys/:provider
userRouter.put(
    "/api-keys/:provider",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const provider = normalizeApiKeyProvider(req.params.provider);
        if (!provider)
            return void res
                .status(400)
                .json({ detail: "Unsupported provider" });

        const apiKey =
            typeof req.body?.api_key === "string" ? req.body.api_key : null;
        const db = createServerDatabase();
        try {
            if (hasEnvApiKey(provider)) {
                return void res.status(409).json({
                    detail: "This provider is configured by the server environment and cannot be changed from the browser.",
                });
            }
            await saveUserApiKey(userId, provider, apiKey, db);
            const status = await getUserApiKeyStatus(userId, db);
            res.json(status);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/api-keys] save failed", {
                provider,
                error: detail,
            });
            sendInternalError(res, err);
        }
    },
);

// GET /user/mcp-connectors
userRouter.get("/mcp-connectors", requireAuth, async (_req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerDatabase();
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
        const db = createServerDatabase();
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
    requireMfaIfEnrolled,
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
        const db = createServerDatabase();
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

// POST /user/mcp-connectors/presets/patent
userRouter.post(
    "/mcp-connectors/presets/patent",
    requireAuth,
    requireUserFeature("patentConnector"),
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerDatabase();
        try {
            const connector = await provisionPatentMcpConnector(userId, db);
            res.status(201).json(
                await refreshUserMcpConnectorTools(userId, connector.id, db),
            );
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/mcp-connectors] patent preset failed", {
                userId,
                error: detail,
            });
            res.status(400).json({ detail });
        }
    },
);

// PATCH /user/mcp-connectors/:connectorId
userRouter.patch(
    "/mcp-connectors/:connectorId",
    requireAuth,
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerDatabase();
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
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerDatabase();
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
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerDatabase();
        try {
            const redirectUri = `${backendPublicUrl(req)}/user/mcp-connectors/oauth/callback`;
            const result = await startUserMcpConnectorOAuth(
                userId,
                req.params.connectorId,
                redirectUri,
                db,
            );
            res.json({
                ...result,
                callbackOrigin: new URL(redirectUri).origin,
            });
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
    const db = createServerDatabase();
    try {
        if (error) throw new Error(error);
        if (!state || !code)
            throw new Error("OAuth callback is missing state or code.");
        const result = await completeUserMcpConnectorOAuth(state, code, db);
        res.set("Content-Security-Policy", mcpOAuthPopupCsp(nonce))
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
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerDatabase();
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
                return void res.status(401).json({
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
    requireMfaIfEnrolled,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const parsed = readBooleanBodyField(req.body, "enabled");
        if (!parsed.ok)
            return void res.status(400).json({ detail: parsed.detail });

        const db = createServerDatabase();
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
userRouter.delete(
    "/account",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerDatabase();
        try {
            await deleteUserAccountData(db, userId, userEmail);
            const { error } = await db.auth.admin.deleteUser(userId);
            if (error)
                return void sendInternalError(res, error);
            res.status(204).send();
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/account] delete failed", {
                userId,
                error: detail,
            });
            sendInternalError(res, err);
        }
    },
);

// DELETE /user/chats
userRouter.delete(
    "/chats",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerDatabase();
        try {
            await deleteAllUserChats(db, userId);
            res.status(204).send();
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/chats] delete failed", {
                userId,
                error: detail,
            });
            sendInternalError(res, err);
        }
    },
);

// DELETE /user/projects
userRouter.delete(
    "/projects",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerDatabase();
        try {
            await deleteUserProjects(db, userId);
            res.status(204).send();
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/projects] delete failed", {
                userId,
                error: detail,
            });
            sendInternalError(res, err);
        }
    },
);

// DELETE /user/tabular-reviews
userRouter.delete(
    "/tabular-reviews",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const db = createServerDatabase();
        try {
            await deleteAllUserTabularReviews(db, userId);
            res.status(204).send();
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/tabular-reviews] delete failed", {
                userId,
                error: detail,
            });
            sendInternalError(res, err);
        }
    },
);

// GET /user/export
userRouter.get(
    "/export",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerDatabase();
        try {
            const data = await buildUserAccountExport(db, userId, userEmail);
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${userExportFilename("account", userId)}"`,
            );
            void recordAudit(createServerDatabase(), {
                userId,
                userEmail: res.locals.userEmail as string | undefined,
                action: "export.account",
                surface: "account",
            });
            res.json(data);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/export] failed", { userId, error: detail });
            sendInternalError(res, err);
        }
    },
);

// GET /user/chats/export
userRouter.get(
    "/chats/export",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerDatabase();
        try {
            const data = await buildUserChatsExport(db, userId, userEmail);
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${userExportFilename("chats", userId)}"`,
            );
            void recordAudit(createServerDatabase(), {
                userId,
                userEmail: res.locals.userEmail as string | undefined,
                action: "export.chats",
                surface: "account",
            });
            res.json(data);
        } catch (err) {
            const detail = errorMessage(err);
            console.error("[user/chats/export] failed", {
                userId,
                error: detail,
            });
            sendInternalError(res, err);
        }
    },
);

// GET /user/tabular-reviews/export
userRouter.get(
    "/tabular-reviews/export",
    requireAuth,
    requireMfaIfEnrolled,
    async (_req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const db = createServerDatabase();
        try {
            const data = await buildUserTabularReviewsExport(
                db,
                userId,
                userEmail,
            );
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="${userExportFilename("tabular-reviews", userId)}"`,
            );
            void recordAudit(createServerDatabase(), {
                userId,
                userEmail: res.locals.userEmail as string | undefined,
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
            sendInternalError(res, err);
        }
    },
);
