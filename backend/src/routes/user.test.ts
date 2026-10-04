import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import request from "supertest";

const {
  validateSupabaseTokenMock,
  validateLocalTokenMock,
  validateEntraTokenMock,
  upsertUserProfileMock,
  createServerSupabaseMock,
  getUserApiKeysMock,
  setUserApiKeyMock,
  deleteUserApiKeyMock,
  deleteUserAccountDataMock,
  listUserMcpConnectorsMock,
  getUserMcpConnectorMock,
  createUserMcpConnectorMock,
  updateUserMcpConnectorMock,
  deleteUserMcpConnectorMock,
  startUserMcpConnectorOAuthMock,
  completeUserMcpConnectorOAuthMock,
  refreshUserMcpConnectorToolsMock,
  setUserMcpToolEnabledMock,
  FakeMcpOAuthRequiredError,
} = vi.hoisted(() => {
  // Mirrors lib/mcp/oauth's McpOAuthRequiredError closely enough for the
  // route's instanceof check (the route imports the class from the SAME
  // mocked module, so instanceof matches this fake, not the real one).
  class FakeMcpOAuthRequiredError extends Error {
    code = "oauth_required";
  }
  return {
    validateSupabaseTokenMock: vi.fn(),
    validateLocalTokenMock: vi.fn(),
    validateEntraTokenMock: vi.fn(),
    upsertUserProfileMock: vi.fn(),
    createServerSupabaseMock: vi.fn(),
    getUserApiKeysMock: vi.fn(),
    setUserApiKeyMock: vi.fn(),
    deleteUserApiKeyMock: vi.fn(),
    deleteUserAccountDataMock: vi.fn(),
    listUserMcpConnectorsMock: vi.fn(),
    getUserMcpConnectorMock: vi.fn(),
    createUserMcpConnectorMock: vi.fn(),
    updateUserMcpConnectorMock: vi.fn(),
    deleteUserMcpConnectorMock: vi.fn(),
    startUserMcpConnectorOAuthMock: vi.fn(),
    completeUserMcpConnectorOAuthMock: vi.fn(),
    refreshUserMcpConnectorToolsMock: vi.fn(),
    setUserMcpToolEnabledMock: vi.fn(),
    FakeMcpOAuthRequiredError,
  };
});

vi.mock("../lib/auth/providers/supabase.js", () => ({
  validateSupabaseToken: validateSupabaseTokenMock,
}));
vi.mock("../lib/auth/providers/local.js", () => ({
  validateLocalToken: validateLocalTokenMock,
}));
vi.mock("../lib/auth/providers/entra.js", () => ({
  validateEntraToken: validateEntraTokenMock,
}));
vi.mock("../lib/userSettings.js", () => ({
  upsertUserProfile: upsertUserProfileMock,
}));
vi.mock("../lib/supabase", () => ({
  createServerSupabase: createServerSupabaseMock,
}));
vi.mock("../lib/userApiKeys", () => ({
  getUserApiKeys: getUserApiKeysMock,
  resolveVercelApiKey: vi.fn(async () => ""),
  setUserApiKey: setUserApiKeyMock,
  deleteUserApiKey: deleteUserApiKeyMock,
}));
// Partial mock: DELETE /account delegates its cascade (including storage
// cleanup) to deleteUserAccountData; the other cleanup helpers stay real
// for the per-resource DELETE routes.
vi.mock(import("../lib/userDataCleanup"), async (importOriginal) => ({
  ...(await importOriginal()),
  deleteUserAccountData: deleteUserAccountDataMock,
}));
vi.mock("../lib/mcpConnectors", () => ({
  listUserMcpConnectors: listUserMcpConnectorsMock,
  getUserMcpConnector: getUserMcpConnectorMock,
  createUserMcpConnector: createUserMcpConnectorMock,
  updateUserMcpConnector: updateUserMcpConnectorMock,
  deleteUserMcpConnector: deleteUserMcpConnectorMock,
  startUserMcpConnectorOAuth: startUserMcpConnectorOAuthMock,
  completeUserMcpConnectorOAuth: completeUserMcpConnectorOAuthMock,
  refreshUserMcpConnectorTools: refreshUserMcpConnectorToolsMock,
  setUserMcpToolEnabled: setUserMcpToolEnabledMock,
  McpOAuthRequiredError: FakeMcpOAuthRequiredError,
}));

vi.mock("../lib/routerModels", () => ({
  ROUTER_SLUGS: ["openrouter", "vercel", "opencode-go"],
  isRouterModelSelected: (model: string, selected: Record<string, string[]>) => {
    const slug = ["openrouter", "vercel", "opencode-go"].find(prefix => model.startsWith(`${prefix}/`));
    return !slug || selected[slug]?.includes(model.slice(slug.length + 1)) === true;
  },
  getAllUserRouterModels: vi.fn(async () => ({ openrouter: [], vercel: [], "opencode-go": [] })),
  replaceUserRouterModels: vi.fn(async () => {}),
}));
import { makeApp } from "../test/helpers/buildTestApp";
import { makeFakeDb } from "../test/helpers/fakeDb";
import { getAllUserRouterModels, replaceUserRouterModels } from "../lib/routerModels";

const TOUCHED_ENV = [
  "AUTH_PROVIDER",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "MOONSHOT_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "ENTRA_MEMBER_GROUP_IDS",
  "ENTRA_ADMIN_GROUP_IDS",
  "NODE_ENV",
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_DEFAULT_KEY",
  "DB_JOBS_ENABLED",
] as const;
const envSnapshot = {} as Record<string, string | undefined>;

const callerPrincipal = {
  userId: "user-1",
  email: "caller@example.com",
  groups: [],
  roles: [],
  provider: "supabase",
};

const emptyKeys = {
  claude: null,
  gemini: null,
  openai: null,
  azureOpenai: null,
};

beforeEach(() => {
  for (const k of TOUCHED_ENV) envSnapshot[k] = process.env[k];
  for (const k of TOUCHED_ENV) delete process.env[k];
  process.env.NODE_ENV = "test";
  process.env.AUTH_PROVIDER = "supabase";

  validateSupabaseTokenMock.mockReset();
  validateSupabaseTokenMock.mockResolvedValue({
    ok: true,
    principal: callerPrincipal,
  });
  validateLocalTokenMock.mockReset();
  validateLocalTokenMock.mockResolvedValue({
    ok: true,
    principal: callerPrincipal,
  });
  validateEntraTokenMock.mockReset();
  validateEntraTokenMock.mockResolvedValue({
    ok: true,
    principal: callerPrincipal,
  });
  upsertUserProfileMock.mockReset();
  upsertUserProfileMock.mockResolvedValue(undefined);
  createServerSupabaseMock.mockReset();
  createServerSupabaseMock.mockImplementation(() => makeDb({}).db);
  getUserApiKeysMock.mockReset();
  getUserApiKeysMock.mockResolvedValue(emptyKeys);
  setUserApiKeyMock.mockReset();
  setUserApiKeyMock.mockResolvedValue(undefined);
  deleteUserApiKeyMock.mockReset();
  deleteUserAccountDataMock.mockReset();
  deleteUserAccountDataMock.mockResolvedValue(undefined);
  deleteUserApiKeyMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of TOUCHED_ENV) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

describe("POST /api/user/security/password-set", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "https://auth.example.test";
    process.env.SUPABASE_PUBLISHABLE_DEFAULT_KEY = "public-key";
  });

  it("keeps the marker unset when the current-user provider rejects the change", async () => {
    const provider = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "reauthentication_needed" }), { status: 422 }));
    vi.stubGlobal("fetch", provider);
    const { db, calls } = makeDb({});
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp()).post("/api/user/security/password-set")
      .set("Authorization", "Bearer caller-token")
      .send({ password: "securepass123" });

    expect(res.status).toBe(422);
    expect(calls.some(call => call.type === "update")).toBe(false);
    expect(provider).toHaveBeenCalledWith(
      new URL("https://auth.example.test/auth/v1/user"),
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({ Authorization: "Bearer caller-token", apikey: "public-key" }),
      }),
    );
  });

  it("rejects a provider response for a different user without setting the marker", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "another-user" }), { status: 200 })));
    const { db, calls } = makeDb({});
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp()).post("/api/user/security/password-set")
      .set("Authorization", "Bearer caller-token")
      .send({ password: "securepass123", nonce: "123456" });

    expect(res.status).toBe(502);
    expect(calls.some(call => call.type === "update")).toBe(false);
    expect(JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string)).toEqual({
      password: "securepass123", nonce: "123456",
    });
  });

  it("marks only after the provider confirms the authenticated user", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "user-1" }), { status: 200 })));
    const { db, calls } = makeDb({ profile: { data: { user_id: "user-1", password_set_at: "2026-10-03T00:00:00Z" } } });
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp()).post("/api/user/security/password-set")
      .set("Authorization", "Bearer caller-token")
      .send({ password: "securepass123" });

    expect(res.status).toBe(200);
    expect(calls).toContainEqual(expect.objectContaining({ type: "update", patch: expect.objectContaining({ password_set_at: expect.any(String) }) }));
    expect(calls).toContainEqual({ type: "eq", col: "user_id", val: "user-1" });
  });
});

/**
 * Build a fake supabase client that records every from/select/eq/update/delete
 * call so tests can assert on order, table, and patches.
 */
type Action =
  | { type: "from"; table: string }
  | { type: "select"; cols: string }
  | { type: "eq"; col: string; val: unknown }
  | { type: "single" }
  | { type: "update"; patch: Record<string, unknown> }
  | { type: "delete" };

function makeDb(opts: {
  profile?: { data?: unknown; error?: { message: string } | null };
  update?: { error?: { message: string } | null };
  deleteResults?: Array<{ error?: { message: string } | null }>;
}) {
  const calls: Action[] = [];
  let deleteCallIdx = 0;
  const db = {
    from: vi.fn((table: string) => {
      if (table === "account_erasure_requests") {
        const erasureQuery: Record<string, unknown> = {};
        erasureQuery.select = () => erasureQuery;
        erasureQuery.eq = () => erasureQuery;
        erasureQuery.maybeSingle = () => Promise.resolve({ data: null, error: null });
        return erasureQuery;
      }
      calls.push({ type: "from", table });
      const b: Record<string, unknown> = {};
      b.select = (cols: string) => {
        calls.push({ type: "select", cols });
        return b;
      };
      b.eq = (col: string, val: unknown) => {
        calls.push({ type: "eq", col, val });
        // The chain for delete().eq() resolves; for select().eq().single() the
        // single() is the terminator. We support both by being a thenable
        // here that yields the configured update/delete result.
        return Object.assign(
          b,
          {
            then: (
              onFulfilled: (v: { error?: { message: string } | null }) => unknown,
              onRejected?: (e: unknown) => unknown,
            ) => {
              // Pick the right pending result based on what's been queued.
              // A bare select().eq() with no update/delete won't typically
              // be awaited (single() is the terminator).
              const pending = opts.deleteResults?.[deleteCallIdx++] ??
                opts.update ?? { error: null };
              return Promise.resolve(pending).then(onFulfilled, onRejected);
            },
          },
        );
      };
      b.single = () => {
        calls.push({ type: "single" });
        return Promise.resolve(opts.profile ?? { data: null, error: null });
      };
      b.maybeSingle = () => Promise.resolve({ data: null, error: null });
      b.update = (patch: Record<string, unknown>) => {
        calls.push({ type: "update", patch });
        return b;
      };
      b.delete = () => {
        calls.push({ type: "delete" });
        return b;
      };
      return b;
    }),
    rpc: vi.fn(async (name: string) => name === "request_account_erasure"
      ? { data: "queued-erasure", error: null }
      : { data: null, error: { message: "unexpected RPC" } }),
  };
  return { db, calls };
}

// ── GET /api/user/profile ───────────────────────────────────────────────

describe("GET /api/user/profile — wiring and shape", () => {
  it("requires authentication — 401 without a header", async () => {
    const res = await request(makeApp()).get("/api/user/profile");

    expect(res.status).toBe(401);
    expect(createServerSupabaseMock).not.toHaveBeenCalled();
  });

  // OSS-6: the profile speaks upstream's camelCase shape (UserProfile +
  // apiKeyStatus) instead of dev's snake_case `*_configured` flags.
  it("returns upstream's camelCase profile with apiKeyStatus and no credential values", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const { db } = makeDb({
      profile: {
        data: {
          display_name: "Caller",
          organisation: "Acme",
          message_credits_used: 12,
          credits_reset_date: future,
          tier: "pro",
          tabular_model: "gpt-5.4",
          fast_model: "aoai:title-deploy",
          legal_research_us: false,
        },
      },
    });
    createServerSupabaseMock.mockReturnValue(db);
    getUserApiKeysMock.mockResolvedValueOnce({
      claude: "sk-c",
      gemini: null,
      openai: "sk-o",
      azureOpenai: {
        endpoint: "https://x.openai.azure.com",
        deployment: "gpt-5",
        apiKey: "az-key",
        apiVersion: "2024-02-15-preview",
      },
    });

    const res = await request(makeApp())
      .get("/api/user/profile")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      displayName: "Caller",
      organisation: "Acme",
      jurisdiction: null,
      practiceSetting: null,
      professionalTitle: null,
      practiceAreas: [],
      onboardingComplete: true,
      onboardingVersion: 0,
      passwordSet: null,
      messageCreditsUsed: 12,
      creditsResetDate: future,
      creditsRemaining: 999999 - 12,
      tier: "pro",
      titleModel: "aoai:title-deploy",
      tabularModel: "gpt-5.4",
      lastSelectedChatModel: null,
      lastSelectedReasoningLevel: "high",
      mfaOnLogin: false,
      legalResearchUs: false,
      quickActionsVisible: true,
      darkMode: false,
      openRouterModels: [],
      vercelModels: [],
      openCodeGoModels: [],
      apiKeyStatus: {
        claude: true,
        gemini: false,
        openai: true,
        kimi: false,
        openrouter: false,
        vercel: false,
        "opencode-go": false,
        courtlistener: false,
        azure_openai: true,
        // Legacy per-user rows report "user"; organisation secrets "env".
        sources: {
          claude: "user",
          gemini: null,
          openai: "user",
          kimi: null,
          openrouter: null,
          vercel: null,
          "opencode-go": null,
          courtlistener: null,
          azure_openai: "user",
        },
      },
    });
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain("sk-c");
    expect(bodyStr).not.toContain("az-key");
  });

  it("leaves unset title and tabular model preferences explicit", async () => {
    const { db } = makeDb({
      profile: {
        data: {
          display_name: null,
          organisation: null,
          message_credits_used: 0,
          credits_reset_date: new Date(Date.now() + 86_400_000).toISOString(),
          tier: null,
          tabular_model: null,
          fast_model: null,
          legal_research_us: null,
        },
      },
    });
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .get("/api/user/profile")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      titleModel: "",
      tabularModel: null,
      tier: "Free",
      legalResearchUs: true,
      mfaOnLogin: false,
    });
  });

  it("normalises a past credits_reset_date to 30-days-out (note: current code does NOT roll the credit count in this case — see PIN below)", async () => {
    // PIN: the rolling block (`if (resetDate <= now)`) is currently
    // unreachable when credits_reset_date is in the past, because
    // normalizeCreditsResetDate has already rewritten it to a future date.
    // This test pins today's behaviour: credits unchanged, reset_date
    // advanced, NO update written. If a refactor fixes the rolling logic
    // this assertion will fail and the rewrite should be intentional.
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const { db, calls } = makeDb({
      profile: {
        data: {
          display_name: "U",
          organisation: null,
          message_credits_used: 99,
          credits_reset_date: past,
          tier: null,
          tabular_model: null,
          fast_model: null,
        },
      },
    });
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .get("/api/user/profile")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(200);
    // Credits NOT rolled today (refactor target).
    expect(res.body.messageCreditsUsed).toBe(99);
    // Reset date pushed 30 days out from now.
    const newReset = new Date(res.body.creditsResetDate).getTime();
    expect(newReset).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    // No DB update written.
    expect(calls.find((c) => c.type === "update")).toBeUndefined();
  });

  it("does NOT roll when credits_reset_date is comfortably in the future", async () => {
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const { db, calls } = makeDb({
      profile: {
        data: {
          display_name: "U",
          organisation: null,
          message_credits_used: 7,
          credits_reset_date: future,
          tier: null,
          tabular_model: null,
          fast_model: null,
        },
      },
    });
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .get("/api/user/profile")
      .set("Authorization", "Bearer ok");

    expect(res.body.messageCreditsUsed).toBe(7);
    expect(res.body.creditsResetDate).toBe(future);
    expect(calls.find((c) => c.type === "update")).toBeUndefined();
  });

  it("normalises a missing or invalid credits_reset_date by setting one 30 days out", async () => {
    const { db } = makeDb({
      profile: {
        data: {
          display_name: "U",
          organisation: null,
          message_credits_used: 0,
          credits_reset_date: null,
          tier: null,
          tabular_model: null,
          fast_model: null,
        },
      },
    });
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .get("/api/user/profile")
      .set("Authorization", "Bearer ok");

    expect(res.body.creditsResetDate).toMatch(/Z$/);
    const t = new Date(res.body.creditsResetDate).getTime();
    expect(t).toBeGreaterThan(Date.now() + 29 * 86_400_000);
  });

  it("reflects organisation secrets (env fallback) in apiKeyStatus with source \"env\" WITHOUT echoing values", async () => {
    process.env.ANTHROPIC_API_KEY = "shared-claude-secret";
    process.env.GEMINI_API_KEY = "  ";
    process.env.OPENAI_API_KEY = "shared-openai-secret";
    process.env.MOONSHOT_API_KEY = "shared-kimi-secret";
    process.env.AZURE_OPENAI_ENDPOINT = "https://x.openai.azure.com";
    process.env.AZURE_OPENAI_API_KEY = "shared-azure-secret";
    const { db } = makeDb({
      profile: {
        data: {
          display_name: "U",
          organisation: null,
          message_credits_used: 0,
          credits_reset_date: new Date(Date.now() + 86_400_000).toISOString(),
          tier: null,
          tabular_model: null,
          fast_model: null,
        },
      },
    });
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .get("/api/user/profile")
      .set("Authorization", "Bearer ok");

    expect(res.body.apiKeyStatus).toEqual({
      claude: true,
      gemini: false,
      openrouter: false,
        vercel: false,
        "opencode-go": false,
      courtlistener: false,
      openai: true,
      kimi: true,
      azure_openai: true,
      sources: {
        claude: "env",
        gemini: null,
        openrouter: null,
          vercel: null,
          "opencode-go": null,
        courtlistener: null,
        openai: "env",
        kimi: "env",
        azure_openai: "env",
      },
    });
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain("shared-claude-secret");
    expect(bodyStr).not.toContain("shared-openai-secret");
    expect(bodyStr).not.toContain("shared-kimi-secret");
    expect(bodyStr).not.toContain("shared-azure-secret");
  });

  it("returns 500 when the profile read errors", async () => {
    const { db } = makeDb({
      profile: { data: null, error: { message: "row not found" } },
    });
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .get("/api/user/profile")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: "internal_error", detail: "Something went wrong. Please try again." });
  });
});

// ── PATCH /api/user/profile ─────────────────────────────────────────────

describe("PATCH /api/user/profile — body validation", () => {
  it("persists normalized router selections for the authenticated user", async () => {
    const { db } = makeDb({ profile: { data: {
      user_id: "user-1",
      credits_reset_date: new Date(Date.now() + 86_400_000).toISOString(),
    } } });
    createServerSupabaseMock.mockReturnValue(db);
    const response = await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({ openRouterModels: ["openrouter/openai/gpt-5.4"], vercelModels: [] });
    expect(response.status).toBe(200);
    expect(replaceUserRouterModels).toHaveBeenCalledWith(
      "user-1", "openrouter", ["openai/gpt-5.4"], db,
    );
    expect(replaceUserRouterModels).toHaveBeenCalledWith("user-1", "vercel", [], db);
    expect(getAllUserRouterModels).toHaveBeenCalledWith("user-1", db);
  });

  it("rejects duplicate router IDs and organisation credential writes", async () => {
    createServerSupabaseMock.mockReturnValue(makeDb({}).db);
    const app = makeApp();
    const duplicate = await request(app).patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({ vercelModels: ["openai/gpt-5.4", "vercel/openai/gpt-5.4"] });
    expect(duplicate.status).toBe(400);
    expect(replaceUserRouterModels).not.toHaveBeenCalled();
    const credential = await request(app).put("/api/user/api-keys/vercel")
      .set("Authorization", "Bearer ok").send({ apiKey: "test-only-value" });
    expect(credential.status).toBe(403);
    expect(setUserApiKeyMock).not.toHaveBeenCalled();
  });

  // OSS-6: upstream's validator — unknown fields are a 400 naming the field
  // (was dev's "No updatable profile fields provided").
  it("returns 400 naming an unsupported field", async () => {
    const { db } = makeDb({});
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({ unrelated_field: "value" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      detail: "Unsupported profile field: unrelated_field",
    });
  });

  it("rejects dev's old snake_case profile fields", async () => {
    const { db } = makeDb({});
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({ fast_model: "gpt-5.4-lite" });

    expect(res.status).toBe(400);
    expect(res.body.detail).toBe("Unsupported profile field: fast_model");
  });

  it("rejects an unknown titleModel and a non-boolean legalResearchUs", async () => {
    const { db } = makeDb({});
    createServerSupabaseMock.mockReturnValue(db);

    const bad = await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({ titleModel: "not-a-model" });
    expect(bad.status).toBe(400);
    expect(bad.body.detail).toBe("Unsupported titleModel");

    const flag = await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({ legalResearchUs: "yes" });
    expect(flag.status).toBe(400);
    expect(flag.body.detail).toBe("legalResearchUs must be a boolean");
  });
});

describe("PATCH /api/user/profile — profile-field updates", () => {
  it("persists a per-user dark mode boolean and returns the canonical value", async () => {
    const { db, calls } = makeDb({ profile: { data: {
      display_name: "Caller", organisation: null, message_credits_used: 0,
      credits_reset_date: new Date(Date.now() + 86_400_000).toISOString(),
      dark_mode: true,
    } } });
    createServerSupabaseMock.mockReturnValue(db);
    const res = await request(makeApp()).patch("/api/user/profile")
      .set("Authorization", "Bearer ok").send({ darkMode: true });
    expect(res.status).toBe(200);
    expect(calls.find((call) => call.type === "update")?.patch).toMatchObject({ dark_mode: true });
    expect(res.body.darkMode).toBe(true);
  });
  it("updates display_name and organisation, stamps updated_at, and returns the canonical post-update view", async () => {
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const { db, calls } = makeDb({
      profile: {
        data: {
          display_name: "Caller After Patch",
          organisation: "New Org",
          message_credits_used: 0,
          credits_reset_date: future,
          tier: null,
          tabular_model: null,
          fast_model: null,
        },
      },
    });
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({
        displayName: "Caller After Patch",
        organisation: "New Org",
      });

    expect(res.status).toBe(200);
    const update = calls.find((c) => c.type === "update");
    expect(update?.patch).toMatchObject({
      display_name: "Caller After Patch",
      organisation: "New Org",
      updated_at: expect.any(String),
    });
    expect(res.body.displayName).toBe("Caller After Patch");
  });

  it("maps titleModel to dev's fast_model column (\"\" = no preference → null)", async () => {
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const row = {
      display_name: null,
      organisation: null,
      message_credits_used: 0,
      credits_reset_date: future,
      tier: null,
      tabular_model: null,
      fast_model: null,
    };
    const first = makeDb({ profile: { data: row } });
    createServerSupabaseMock.mockReturnValue(first.db);
    const set = await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({ titleModel: "aoai:my-deploy", tabularModel: "gpt-5.4", legalResearchUs: false });
    expect(set.status).toBe(200);
    expect(first.calls.find((c) => c.type === "update")).toMatchObject({
      patch: {
        fast_model: "aoai:my-deploy",
        tabular_model: "gpt-5.4",
        legal_research_us: false,
      },
    });

    const second = makeDb({ profile: { data: row } });
    createServerSupabaseMock.mockReturnValue(second.db);
    const clear = await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({ titleModel: "" });
    expect(clear.status).toBe(200);
    expect(second.calls.find((c) => c.type === "update")).toMatchObject({
      patch: { fast_model: null },
    });
    expect(clear.body.titleModel).toBe("");
  });

  it("returns 500 when the profile update query errors", async () => {
    const { db } = makeDb({
      update: { error: { message: "tx conflict" } },
    });
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({ displayName: "X" });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: "internal_error", detail: "Something went wrong. Please try again." });
  });

  it("returns 500 when the post-update re-fetch errors", async () => {
    const { db } = makeDb({
      profile: { data: null, error: { message: "re-fetch failed" } },
    });
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({ displayName: "X" });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: "internal_error", detail: "Something went wrong. Please try again." });
  });
});

describe("PATCH /api/user/profile — legacy provider key fields", () => {
  it("rejects clearing a personal provider key", async () => {
    const { db } = makeDb({
      profile: {
        data: {
          display_name: "U",
          organisation: null,
          message_credits_used: 0,
          credits_reset_date: new Date(Date.now() + 86_400_000).toISOString(),
          tier: null,
          tabular_model: null,
          fast_model: null,
        },
      },
    });
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({ claude_api_key: "" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("organisation_api_key_required");
    expect(deleteUserApiKeyMock).not.toHaveBeenCalled();
    expect(setUserApiKeyMock).not.toHaveBeenCalled();
  });

  it("rejects setting a personal provider key", async () => {
    const { db } = makeDb({
      profile: {
        data: {
          display_name: "U",
          organisation: null,
          message_credits_used: 0,
          credits_reset_date: new Date(Date.now() + 86_400_000).toISOString(),
          tier: null,
          tabular_model: null,
          fast_model: null,
        },
      },
    });
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({ openai_api_key: "sk-new" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("organisation_api_key_required");
    expect(setUserApiKeyMock).not.toHaveBeenCalled();
    expect(deleteUserApiKeyMock).not.toHaveBeenCalled();
  });

  it("rejects before legacy encryption storage is called", async () => {
    const { db } = makeDb({});
    createServerSupabaseMock.mockReturnValue(db);
    setUserApiKeyMock.mockRejectedValueOnce(new Error("encryption secret missing"));

    const res = await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({ claude_api_key: "sk" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("organisation_api_key_required");
    expect(setUserApiKeyMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/user/profile — legacy Azure OpenAI fields", () => {
  it("rejects a partial personal Azure OpenAI update", async () => {
    const { db } = makeDb({
      profile: {
        data: {
          display_name: "U",
          organisation: null,
          message_credits_used: 0,
          credits_reset_date: new Date(Date.now() + 86_400_000).toISOString(),
          tier: null,
          tabular_model: null,
          fast_model: null,
        },
      },
    });
    createServerSupabaseMock.mockReturnValue(db);
    getUserApiKeysMock.mockResolvedValue({
      ...emptyKeys,
      azureOpenai: {
        endpoint: "https://existing.openai.azure.com",
        deployment: "existing-deploy",
        apiKey: "existing-key",
        apiVersion: "2024-02-15-preview",
      },
    });

    const res = await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({ azure_openai_deployment: "new-deploy" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("organisation_api_key_required");
    expect(setUserApiKeyMock).not.toHaveBeenCalled();
  });

  it("rejects clearing personal Azure OpenAI settings", async () => {
    const { db } = makeDb({
      profile: {
        data: {
          display_name: "U",
          organisation: null,
          message_credits_used: 0,
          credits_reset_date: new Date(Date.now() + 86_400_000).toISOString(),
          tier: null,
          tabular_model: null,
          fast_model: null,
        },
      },
    });
    createServerSupabaseMock.mockReturnValue(db);
    getUserApiKeysMock.mockResolvedValue({
      ...emptyKeys,
      azureOpenai: {
        endpoint: "x",
        deployment: "y",
        apiKey: null,
        apiVersion: null,
      },
    });

    const res = await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({
        azure_openai_endpoint: "",
        azure_openai_deployment: "",
      });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("organisation_api_key_required");
    expect(deleteUserApiKeyMock).not.toHaveBeenCalled();
    expect(setUserApiKeyMock).not.toHaveBeenCalled();
  });

  it("rejects before the legacy Azure delete path is called", async () => {
    const { db } = makeDb({});
    createServerSupabaseMock.mockReturnValue(db);
    getUserApiKeysMock.mockResolvedValue({
      ...emptyKeys,
      azureOpenai: { endpoint: "x", deployment: "y", apiKey: null, apiVersion: null },
    });
    deleteUserApiKeyMock.mockRejectedValueOnce(new Error("aoai delete failed"));

    const res = await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({ azure_openai_endpoint: "", azure_openai_deployment: "" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("organisation_api_key_required");
    expect(deleteUserApiKeyMock).not.toHaveBeenCalled();
  });

  it("rejects before the legacy Azure set path is called", async () => {
    const { db } = makeDb({});
    createServerSupabaseMock.mockReturnValue(db);
    getUserApiKeysMock.mockResolvedValue(emptyKeys);
    setUserApiKeyMock.mockRejectedValueOnce(new Error("encryption failed"));

    const res = await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({
        azure_openai_endpoint: "https://x.openai.azure.com",
        azure_openai_deployment: "dep",
      });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("organisation_api_key_required");
    expect(setUserApiKeyMock).not.toHaveBeenCalled();
  });

  it("rejects incomplete personal Azure settings with the organisation action", async () => {
    const { db } = makeDb({});
    createServerSupabaseMock.mockReturnValue(db);
    getUserApiKeysMock.mockResolvedValue({
      ...emptyKeys,
      azureOpenai: {
        endpoint: "x",
        deployment: "y",
        apiKey: null,
        apiVersion: null,
      },
    });

    const res = await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({ azure_openai_endpoint: "" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("organisation_api_key_required");
    expect(res.body.detail).toMatch(/administrator.*\/install/i);
    expect(setUserApiKeyMock).not.toHaveBeenCalled();
    expect(deleteUserApiKeyMock).not.toHaveBeenCalled();
  });
});

// ── POST /api/user/profile/credits/increment ───────────────────────────

describe("organisation-managed provider credentials", () => {
  it.each([
    ["claude", "anthropic-api-key"],
    ["gemini", "gemini-api-key"],
    ["openai", "openai-api-key"],
    ["kimi", "moonshot-api-key"],
    ["openrouter", "openrouter-api-key"],
    ["opencode-go", "opencode-api-key"],
    ["courtlistener", "courtlistener-api-token"],
    ["azure_openai", "azure-openai-endpoint"],
  ])(
    "rejects personal %s key writes and names the administrator action",
    async (provider, secretName) => {
      const res = await request(makeApp())
        .put(`/api/user/api-keys/${provider}`)
        .set("Authorization", "Bearer ok")
        .send({ api_key: "not-a-real-key" });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: "organisation_api_key_required",
      });
      expect(res.body.detail).toMatch(/administrator.*\/install/i);
      expect(res.body.detail).toContain(secretName);
      expect(setUserApiKeyMock).not.toHaveBeenCalled();
      expect(deleteUserApiKeyMock).not.toHaveBeenCalled();
    },
  );

  it("rejects legacy provider-key fields on PATCH /profile", async () => {
    const res = await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({ claude_api_key: "not-a-real-key" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: "organisation_api_key_required",
    });
    expect(res.body.detail).toContain("anthropic-api-key");
    expect(setUserApiKeyMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/user/profile/credits/increment", () => {
  it("rejects a request without the session CSRF proof", async () => {
    const res = await request(makeApp()).post(
      "/api/user/profile/credits/increment",
    );

    expect(res.status).toBe(403);
  });

  it("returns the new value (current + 1) and writes it back to the row", async () => {
    const { db, calls } = makeDb({
      profile: { data: { message_credits_used: 7 } },
    });
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .post("/api/user/profile/credits/increment")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message_credits_used: 8 });
    const update = calls.find((c) => c.type === "update");
    expect(update?.patch).toMatchObject({
      message_credits_used: 8,
      updated_at: expect.any(String),
    });
  });

  it("treats a null/undefined message_credits_used as 0 (first-ever message)", async () => {
    const { db } = makeDb({
      profile: { data: { message_credits_used: null } },
    });
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .post("/api/user/profile/credits/increment")
      .set("Authorization", "Bearer ok");

    expect(res.body).toEqual({ message_credits_used: 1 });
  });

  it("returns 500 when the read errors", async () => {
    const { db } = makeDb({
      profile: { data: null, error: { message: "boom" } },
    });
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .post("/api/user/profile/credits/increment")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: "internal_error", detail: "Something went wrong. Please try again." });
  });
});

// ── DELETE /api/user/account ───────────────────────────────────────────

describe("DELETE /api/user/account", () => {
  it("rejects a request without the session CSRF proof", async () => {
    const res = await request(makeApp()).delete("/api/user/account");

    expect(res.status).toBe(403);
  });

  it("queues account erasure in Entra mode without deleting the IdP identity", async () => {
    process.env.AUTH_PROVIDER = "entra";
    // Satisfy the tenantAccess middleware so the request reaches the
    // route handler (which is what we actually want to test).
    process.env.ENTRA_MEMBER_GROUP_IDS = "member-grp";
    validateEntraTokenMock.mockResolvedValueOnce({
      ok: true,
      principal: { ...callerPrincipal, tenantId: "t1", groups: ["member-grp"] },
    });
    // The middleware looks up the tenant row before resolving roles.
    const tenantDb = {
      from: vi.fn((table: string) => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b;
        b.maybeSingle = () =>
          Promise.resolve({
            data: table === "account_erasure_requests" ? null : { tenant_id: "t1", status: "active" },
            error: null,
          });
        return b;
      }),
    };
    const { db } = makeDb({});
    createServerSupabaseMock.mockReturnValueOnce(tenantDb).mockReturnValueOnce(tenantDb).mockReturnValue(db);

    const res = await request(makeApp())
      .delete("/api/user/account")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(202);
    expect(db.rpc).toHaveBeenCalledWith("request_account_erasure", {
      p_user_id: "user-1", p_user_email: "caller@example.com", p_provider: "entra",
    });
  });

  it("atomically queues erasure and returns 202 without inline deletion", async () => {
    const { db, calls } = makeDb({});
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .delete("/api/user/account")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(202);
    expect(db.rpc).toHaveBeenCalledWith("request_account_erasure", {
      p_user_id: "user-1", p_user_email: "caller@example.com", p_provider: "supabase",
    });
    expect(deleteUserAccountDataMock).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("lowercases the principal email in the atomic request", async () => {
    validateSupabaseTokenMock.mockResolvedValueOnce({
      ok: true,
      principal: { ...callerPrincipal, email: "Caller@Example.COM" },
    });
    const { db } = makeDb({ deleteResults: Array(2).fill({ error: null }) });
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .delete("/api/user/account")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(202);
    expect(db.rpc).toHaveBeenCalledWith("request_account_erasure", expect.objectContaining({
      p_user_email: "caller@example.com",
    }));
  });

  it("returns 500 when atomic enqueue fails, and touches no identity tables", async () => {
    const { db, calls } = makeDb({});
    db.rpc.mockResolvedValueOnce({ data: null, error: { message: "queue unavailable" } });
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .delete("/api/user/account")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(500);
    expect(res.body.detail).toBe("Something went wrong. Please try again.");
    expect(calls.filter((c) => c.type === "from")).toEqual([]);
  });

  it("returns 503 when jobs are disabled without queuing deletion", async () => {
    process.env.DB_JOBS_ENABLED = "false";
    const { db } = makeDb({});
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .delete("/api/user/account")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(503);
    expect(db.rpc).not.toHaveBeenCalled();
  });
});

// ── MCP connector endpoints (new in 1.0.10) ──────────────────────────────

describe("MCP connector routes", () => {
  beforeEach(() => {
    validateSupabaseTokenMock.mockResolvedValue({
      ok: true,
      principal: callerPrincipal,
    });
    createServerSupabaseMock.mockReturnValue(makeDb({}).db);
    listUserMcpConnectorsMock.mockReset();
    createUserMcpConnectorMock.mockReset();
    startUserMcpConnectorOAuthMock.mockReset();
    completeUserMcpConnectorOAuthMock.mockReset();
    refreshUserMcpConnectorToolsMock.mockReset();
  });

  it("GET /api/user/mcp-connectors requires auth and returns the list", async () => {
    const unauth = await request(makeApp()).get("/api/user/mcp-connectors");
    expect(unauth.status).toBe(401);

    listUserMcpConnectorsMock.mockResolvedValueOnce([
      { id: "conn-1", name: "GitHub" },
    ]);
    const res = await request(makeApp())
      .get("/api/user/mcp-connectors")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "conn-1", name: "GitHub" }]);
    expect(listUserMcpConnectorsMock).toHaveBeenCalledWith(
      "user-1",
      expect.anything(),
      { includeTools: false },
    );
  });

  it("POST /api/user/mcp-connectors creates and 201s", async () => {
    createUserMcpConnectorMock.mockResolvedValueOnce({ id: "conn-new" });

    const res = await request(makeApp())
      .post("/api/user/mcp-connectors")
      .set("Authorization", "Bearer ok")
      .send({ name: "GH", serverUrl: "https://mcp.example.com", bearerToken: "t" });

    expect(res.status).toBe(201);
    expect(createUserMcpConnectorMock).toHaveBeenCalledWith(
      "user-1",
      { name: "GH", serverUrl: "https://mcp.example.com", bearerToken: "t", headers: undefined },
      expect.anything(),
    );
  });

  it("POST create surfaces the missing-encryption-key error as a 400 detail (image-only-upgrade landmine)", async () => {
    createUserMcpConnectorMock.mockRejectedValueOnce(
      new Error(
        "MCP connectors encryption secret (mcp-connectors-encryption-key) is not configured.",
      ),
    );

    const res = await request(makeApp())
      .post("/api/user/mcp-connectors")
      .set("Authorization", "Bearer ok")
      .send({ name: "GH", serverUrl: "https://mcp.example.com" });

    expect(res.status).toBe(400);
    expect(res.body.detail).toBe("Connector settings are invalid or the server could not be reached.");
  });

  it("oauth/start builds the redirect_uri WITH the /api prefix (regression: 93bc48b)", async () => {
    startUserMcpConnectorOAuthMock.mockResolvedValueOnce({
      authorizationUrl: "https://provider/authorize",
    });

    const res = await request(makeApp())
      .post("/api/user/mcp-connectors/conn-1/oauth/start")
      .set("Authorization", "Bearer ok")
      .set("X-Forwarded-Proto", "https");

    expect(res.status).toBe(200);
    const redirectUri = startUserMcpConnectorOAuthMock.mock.calls[0][2] as string;
    // Without /api the provider's redirect misses the API router, falls
    // through to the SPA catch-all, and bounces the popup to /login.
    expect(redirectUri).toMatch(/\/api\/user\/mcp-connectors\/oauth\/callback$/);
  });

  it("oauth/callback success renders the popup with COOP unsafe-none so window.opener survives (regression: 38224fc)", async () => {
    completeUserMcpConnectorOAuthMock.mockResolvedValueOnce({
      connectorId: "conn-1",
    });

    const res = await request(makeApp()).get(
      "/api/user/mcp-connectors/oauth/callback?state=st&code=co",
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    // Helmet's global same-origin COOP would sever window.opener and the
    // parent would only ever see "OAuth authorization window was closed".
    expect(res.headers["cross-origin-opener-policy"]).toBe("unsafe-none");
    expect(res.headers["content-security-policy"]).toContain("nonce-");
    expect(res.text).toContain("mcp_oauth_result");
    expect(res.text).toContain("conn-1");
  });

  it("oauth/callback failure still 400s as an opener-preserving HTML popup", async () => {
    const res = await request(makeApp()).get(
      "/api/user/mcp-connectors/oauth/callback?error=access_denied",
    );

    expect(res.status).toBe(400);
    expect(res.headers["cross-origin-opener-policy"]).toBe("unsafe-none");
    expect(res.text).toContain("mcp_oauth_result");
    expect(res.text).toContain("mcp_oauth_result");
    expect(res.text).not.toContain("access_denied");
  });

  it("refresh-tools maps McpOAuthRequiredError to 428 + code — NOT 401 (would trigger a spurious logout)", async () => {
    refreshUserMcpConnectorToolsMock.mockRejectedValueOnce(
      new FakeMcpOAuthRequiredError("Provider requires OAuth"),
    );

    const res = await request(makeApp())
      .post("/api/user/mcp-connectors/conn-1/refresh-tools")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(428);
    expect(res.body.code).toBe("oauth_required");
    expect(res.body.detail).toBe("This connector needs to be authorized again.");
  });

  it("refresh-tools maps other failures to 400", async () => {
    refreshUserMcpConnectorToolsMock.mockRejectedValueOnce(
      new Error("connection refused"),
    );

    const res = await request(makeApp())
      .post("/api/user/mcp-connectors/conn-1/refresh-tools")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(400);
    expect(res.body.detail).toBe("Connector tools could not be refreshed.");
  });
});

// ── GET /api/user/lookup (OSS-6 step A, upstream route restored) ─────────

describe("GET /api/user/lookup", () => {
  it("requires authentication — 401 without a header", async () => {
    const res = await request(makeApp()).get(
      "/api/user/lookup?email=person@example.com",
    );

    expect(res.status).toBe(401);
    expect(createServerSupabaseMock).not.toHaveBeenCalled();
  });

  it("returns 400 when email is missing or blank", async () => {
    const missing = await request(makeApp())
      .get("/api/user/lookup")
      .set("Authorization", "Bearer ok");
    const blank = await request(makeApp())
      .get("/api/user/lookup?email=%20%20")
      .set("Authorization", "Bearer ok");

    expect(missing.status).toBe(400);
    expect(missing.body.detail).toBe("email is required");
    expect(blank.status).toBe(400);
    expect(createServerSupabaseMock).toHaveBeenCalledTimes(2); // auth tombstone checks precede route validation
  });

  it("reports an existing profile with its normalised email and display name", async () => {
    const { db, callsFor } = makeFakeDb((call) =>
      call.table === "user_profiles"
        ? {
            data: [
              {
                user_id: "user-2",
                email: "person@example.com",
                display_name: "  Person Two  ",
              },
            ],
          }
        : {},
    );
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .get("/api/user/lookup?email=%20Person@Example.com%20")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      exists: true,
      email: "person@example.com",
      display_name: "Person Two",
    });
    const [lookup] = callsFor("user_profiles", "select");
    expect(lookup.filters).toContainEqual(["eq", "email", "person@example.com"]);
  });

  it("reports a missing profile as exists:false with the normalised email", async () => {
    const { db } = makeFakeDb(() => ({ data: null }));
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .get("/api/user/lookup?email=Nobody@Example.com")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      exists: false,
      email: "nobody@example.com",
      display_name: null,
    });
  });

  it("returns 500 (not a hung request) when the profile query fails", async () => {
    const { db } = makeFakeDb((call) => call.table === "account_erasure_requests"
      ? { data: null, error: null }
      : { data: null, error: { message: "db down" } });
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .get("/api/user/lookup?email=person@example.com")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(500);
    expect(res.body.detail).toBe("Something went wrong. Please try again.");
  });
});
