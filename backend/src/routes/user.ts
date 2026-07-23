import crypto from "crypto";
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { getUserApiKeys } from "../lib/userApiKeys";
import { resolveSecret } from "../lib/envSecrets";
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

userRouter.get("/profile", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();

  // Profile fields live on `user_profiles`; provider keys moved to the
  // encrypted `user_api_keys` table in 0006. Fetched in parallel.
  const [profileResult, apiKeys] = await Promise.all([
    db
      .from("user_profiles")
      .select(
        "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model, fast_model, legal_research_us",
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
    // Features > Legal Research > Jurisdiction > US toggle (upstream
    // 1fa0554); defaults to enabled.
    legal_research_us: data.legal_research_us !== false,
    // Compatibility fields remain in the shape, but organisation credentials
    // never leave the backend. The frontend uses configured booleans.
    claude_api_key: null,
    gemini_api_key: null,
    openai_api_key: null,
    azure_openai_endpoint: null,
    azure_openai_api_key: null,
    azure_openai_api_version: null,
    azure_openai_deployment: null,
    // Forward-compat: per-provider configured booleans the frontend
    // should prefer once the plaintext fields above are dropped.
    claude_configured: !!apiKeys.claude,
    gemini_configured: !!apiKeys.gemini,
    openai_configured: !!apiKeys.openai,
    kimi_configured: !!apiKeys.kimi,
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
      kimi: !!(await resolveSecret("moonshot-api-key")),
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

  const credentialFields: ReadonlyArray<{
    field: string;
    provider: OrganisationCredentialProvider;
  }> = [
    { field: "claude_api_key", provider: "claude" },
    { field: "gemini_api_key", provider: "gemini" },
    { field: "openai_api_key", provider: "openai" },
    { field: "kimi_api_key", provider: "kimi" },
    { field: "openrouter_api_key", provider: "openrouter" },
    { field: "courtlistener_api_token", provider: "courtlistener" },
    { field: "azure_openai_endpoint", provider: "azure_openai" },
    { field: "azure_openai_api_key", provider: "azure_openai" },
    { field: "azure_openai_api_version", provider: "azure_openai" },
    { field: "azure_openai_deployment", provider: "azure_openai" },
  ];
  const attemptedCredential = credentialFields.find(
    ({ field }) => field in req.body,
  );
  if (attemptedCredential) {
    return void organisationCredentialRequired(
      res,
      attemptedCredential.provider,
    );
  }

  const db = createServerSupabase();

  // Profile fields stay on `user_profiles`.
  const profileFields = [
    "display_name",
    "organisation",
    "tabular_model",
    "fast_model",
  ] as const;
  const profileUpdates: Record<string, string | boolean | null> = {};
  for (const field of profileFields) {
    if (field in req.body) {
      const value = req.body[field];
      profileUpdates[field] = typeof value === "string" ? value : value ?? null;
    }
  }

  // Features flag (upstream 1fa0554): boolean toggle for US legal research
  // (CourtListener) tools in chat.
  if ("legal_research_us" in req.body) {
    const value = req.body.legal_research_us;
    if (typeof value !== "boolean") {
      return void res
        .status(400)
        .json({ detail: "legal_research_us must be a boolean" });
    }
    profileUpdates.legal_research_us = value;
  }

  if (Object.keys(profileUpdates).length === 0) {
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

  // Re-fetch to return the canonical post-update view (same shape as GET).
  const [profileResult, apiKeys] = await Promise.all([
    db
      .from("user_profiles")
      .select(
        "display_name, organisation, message_credits_used, credits_reset_date, tier, tabular_model, fast_model, legal_research_us",
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
    claude_api_key: null,
    gemini_api_key: null,
    openai_api_key: null,
    azure_openai_endpoint: null,
    azure_openai_api_key: null,
    azure_openai_api_version: null,
    azure_openai_deployment: null,
    claude_configured: !!apiKeys.claude,
    gemini_configured: !!apiKeys.gemini,
    openai_configured: !!apiKeys.openai,
    kimi_configured: !!apiKeys.kimi,
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

// ---------------------------------------------------------------------------
// Provider credentials are deployment-wide in MikeOssAzure. Every user shares
// the same backend and the same Key Vault-backed integrations; ordinary users
// may choose models/features but must never own or replace provider secrets.
const API_KEY_PROVIDERS = [
  "claude",
  "gemini",
  "openai",
  "kimi",
  "openrouter",
  "courtlistener",
  "azure_openai",
] as const;
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
      credential.secretNames.map((name) => resolveSecret(name)),
    );
    const configured = values.every(Boolean);
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

function frontendUrl(path = "/account/connectors") {
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
        res.status(500).json({ detail });
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
            res.status(404).json({ detail });
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
            res.status(400).json({ detail });
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
            res.status(400).json({ detail });
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
            res.status(500).json({ detail });
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
            res.status(400).json({ detail });
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
            .send(mcpOAuthPopupHtml({ success: false, detail }, nonce));
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
                    detail,
                });
            }
            res.status(400).json({ detail });
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
            res.status(400).json({ detail });
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
