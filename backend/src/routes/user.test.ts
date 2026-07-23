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

import { makeApp } from "../test/helpers/buildTestApp";

const TOUCHED_ENV = [
  "AUTH_PROVIDER",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "ENTRA_MEMBER_GROUP_IDS",
  "ENTRA_ADMIN_GROUP_IDS",
  "NODE_ENV",
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
  for (const k of TOUCHED_ENV) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
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

  it("returns the canonical profile shape with auth fields, plaintext keys, and global flags", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const { db } = makeDb({
      profile: {
        data: {
          display_name: "Caller",
          organisation: "Acme",
          message_credits_used: 12,
          credits_reset_date: future,
          tier: "pro",
          tabular_model: "gpt-5",
          fast_model: "gemini-flash",
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
    expect(res.body).toMatchObject({
      display_name: "Caller",
      organisation: "Acme",
      message_credits_used: 12,
      credits_reset_date: future,
      tier: "pro",
      claude_api_key: "sk-c",
      gemini_api_key: null,
      openai_api_key: "sk-o",
      azure_openai_endpoint: "https://x.openai.azure.com",
      azure_openai_deployment: "gpt-5",
      claude_configured: true,
      gemini_configured: false,
      openai_configured: true,
      azure_openai_configured: true,
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
    expect(res.body.message_credits_used).toBe(99);
    // Reset date pushed 30 days out from now.
    const newReset = new Date(res.body.credits_reset_date).getTime();
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

    expect(res.body.message_credits_used).toBe(7);
    expect(res.body.credits_reset_date).toBe(future);
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

    expect(res.body.credits_reset_date).toMatch(/Z$/);
    const t = new Date(res.body.credits_reset_date).getTime();
    expect(t).toBeGreaterThan(Date.now() + 29 * 86_400_000);
  });

  it("reflects ANTHROPIC_API_KEY/GEMINI_API_KEY/OPENAI_API_KEY env in global_api_keys booleans WITHOUT echoing values", async () => {
    process.env.ANTHROPIC_API_KEY = "shared-claude-secret";
    process.env.GEMINI_API_KEY = "  ";
    process.env.OPENAI_API_KEY = "shared-openai-secret";
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

    expect(res.body.global_api_keys).toEqual({
      claude: true,
      gemini: false,
      openrouter: false,
      courtlistener: false,
      openai: true,
      azureOpenai: true,
    });
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain("shared-claude-secret");
    expect(bodyStr).not.toContain("shared-openai-secret");
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
    expect(res.body).toEqual({ detail: "row not found" });
  });
});

// ── PATCH /api/user/profile ─────────────────────────────────────────────

describe("PATCH /api/user/profile — body validation", () => {
  it("returns 400 when no updatable fields are present in the body", async () => {
    const { db } = makeDb({});
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({ unrelated_field: "value" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      detail: "No updatable profile fields provided",
    });
  });
});

describe("PATCH /api/user/profile — profile-field updates", () => {
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
        display_name: "Caller After Patch",
        organisation: "New Org",
      });

    expect(res.status).toBe(200);
    const update = calls.find((c) => c.type === "update");
    expect(update?.patch).toMatchObject({
      display_name: "Caller After Patch",
      organisation: "New Org",
      updated_at: expect.any(String),
    });
    expect(res.body.display_name).toBe("Caller After Patch");
  });

  it("returns 500 when the profile update query errors", async () => {
    const { db } = makeDb({
      update: { error: { message: "tx conflict" } },
    });
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({ display_name: "X" });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ detail: "tx conflict" });
  });

  it("returns 500 when the post-update re-fetch errors", async () => {
    const { db } = makeDb({
      profile: { data: null, error: { message: "re-fetch failed" } },
    });
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({ display_name: "X" });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ detail: "re-fetch failed" });
  });
});

describe("PATCH /api/user/profile — provider key updates", () => {
  it("DELETES a flat provider key when the value is the empty string", async () => {
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

    await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({ claude_api_key: "" });

    expect(deleteUserApiKeyMock).toHaveBeenCalledWith(
      "user-1",
      "claude",
      expect.anything(),
    );
    expect(setUserApiKeyMock).not.toHaveBeenCalled();
  });

  it("SETs a flat provider key when the value is non-empty", async () => {
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

    await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({ openai_api_key: "sk-new" });

    expect(setUserApiKeyMock).toHaveBeenCalledWith(
      "user-1",
      "openai",
      "sk-new",
      expect.anything(),
    );
    expect(deleteUserApiKeyMock).not.toHaveBeenCalled();
  });

  it("returns 500 when setUserApiKey throws", async () => {
    const { db } = makeDb({});
    createServerSupabaseMock.mockReturnValue(db);
    setUserApiKeyMock.mockRejectedValueOnce(new Error("encryption secret missing"));

    const res = await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({ claude_api_key: "sk" });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ detail: "encryption secret missing" });
  });
});

describe("PATCH /api/user/profile — azure_openai compound", () => {
  it("merges a partial PATCH against the existing config so the other three fields aren't blown away", async () => {
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

    await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({ azure_openai_deployment: "new-deploy" });

    expect(setUserApiKeyMock).toHaveBeenCalledWith(
      "user-1",
      "azure_openai",
      {
        endpoint: "https://existing.openai.azure.com",
        deployment: "new-deploy",
        apiKey: "existing-key",
        apiVersion: "2024-02-15-preview",
      },
      expect.anything(),
    );
  });

  it("DELETES the azure_openai row when both endpoint AND deployment are cleared in the same request", async () => {
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

    await request(makeApp())
      .patch("/api/user/profile")
      .set("Authorization", "Bearer ok")
      .send({
        azure_openai_endpoint: "",
        azure_openai_deployment: "",
      });

    expect(deleteUserApiKeyMock).toHaveBeenCalledWith(
      "user-1",
      "azure_openai",
      expect.anything(),
    );
    expect(setUserApiKeyMock).not.toHaveBeenCalled();
  });

  it("returns 500 when the azure delete throws", async () => {
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

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ detail: "aoai delete failed" });
  });

  it("returns 500 when the azure set throws", async () => {
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

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ detail: "encryption failed" });
  });

  it("returns 400 when only one of endpoint/deployment is cleared (incomplete config)", async () => {
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

    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(
      /Azure OpenAI requires both endpoint and deployment/,
    );
    expect(setUserApiKeyMock).not.toHaveBeenCalled();
    expect(deleteUserApiKeyMock).not.toHaveBeenCalled();
  });
});

// ── POST /api/user/profile/credits/increment ───────────────────────────

describe("POST /api/user/profile/credits/increment", () => {
  it("requires authentication", async () => {
    const res = await request(makeApp()).post(
      "/api/user/profile/credits/increment",
    );

    expect(res.status).toBe(401);
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
    expect(res.body).toEqual({ detail: "boom" });
  });
});

// ── DELETE /api/user/account ───────────────────────────────────────────

describe("DELETE /api/user/account", () => {
  it("requires authentication", async () => {
    const res = await request(makeApp()).delete("/api/user/account");

    expect(res.status).toBe(401);
  });

  it("rejects with 403 in entra mode (account closure must go through tenant admin)", async () => {
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
      from: vi.fn(() => {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b;
        b.maybeSingle = () =>
          Promise.resolve({
            data: { tenant_id: "t1", status: "active" },
            error: null,
          });
        return b;
      }),
    };
    createServerSupabaseMock.mockReturnValueOnce(tenantDb);

    const res = await request(makeApp())
      .delete("/api/user/account")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(403);
    expect(res.body.detail).toMatch(/Self-service account deletion is not available on Entra/);
    // The middleware's tenant query ran (1 createServerSupabase call), but
    // the route handler MUST have bailed before opening its own client.
    expect(createServerSupabaseMock).toHaveBeenCalledTimes(1);
  });

  // Dev's cascade (table rows + storage objects) lives in
  // lib/userDataCleanup.deleteUserAccountData (upstream 3a10943); the
  // route then removes the identity-adjacent tables it still owns and,
  // in supabase mode, the auth user. These tests cover the route's
  // orchestration; the cascade internals belong to userDataCleanup.

  function withAuthAdmin(
    db: Record<string, unknown>,
    result: { error: { message: string } | null } = { error: null },
  ) {
    (db as { auth?: unknown }).auth = {
      admin: { deleteUser: vi.fn(() => Promise.resolve(result)) },
    };
    return db;
  }

  it("runs the cascade, deletes identity tables, deletes the auth user, then 204s", async () => {
    const { db, calls } = makeDb({
      deleteResults: Array(2).fill({ error: null }),
    });
    withAuthAdmin(db);
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .delete("/api/user/account")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(204);
    expect(deleteUserAccountDataMock).toHaveBeenCalledWith(
      db,
      "user-1",
      "caller@example.com",
    );
    const tablesInOrder = calls
      .filter((c) => c.type === "from")
      .map((c) => c.table);
    expect(tablesInOrder).toEqual(["user_api_keys", "user_profiles"]);
    expect(
      (db as { auth: { admin: { deleteUser: ReturnType<typeof vi.fn> } } })
        .auth.admin.deleteUser,
    ).toHaveBeenCalledWith("user-1");
  });

  it("lowercases the principal email before handing it to the cascade", async () => {
    validateSupabaseTokenMock.mockResolvedValueOnce({
      ok: true,
      principal: { ...callerPrincipal, email: "Caller@Example.COM" },
    });
    const { db } = makeDb({ deleteResults: Array(2).fill({ error: null }) });
    withAuthAdmin(db);
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .delete("/api/user/account")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(204);
    expect(deleteUserAccountDataMock).toHaveBeenCalledWith(
      db,
      "user-1",
      "caller@example.com",
    );
  });

  it("returns 500 with the thrown message when the cascade fails, and touches no identity tables", async () => {
    deleteUserAccountDataMock.mockRejectedValueOnce(
      new Error("Failed to delete user data from chats: deadlock"),
    );
    const { db, calls } = makeDb({});
    withAuthAdmin(db);
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .delete("/api/user/account")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(500);
    expect(res.body.detail).toBe(
      "Failed to delete user data from chats: deadlock",
    );
    expect(calls.filter((c) => c.type === "from")).toEqual([]);
  });

  it("returns 500 naming the identity table when its delete fails, and never reaches the auth user", async () => {
    const { db } = makeDb({
      deleteResults: [{ error: { message: "permission denied" } }],
    });
    withAuthAdmin(db);
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .delete("/api/user/account")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(500);
    expect(res.body.detail).toBe(
      "Failed to delete user data from user_api_keys: permission denied",
    );
    expect(
      (db as { auth: { admin: { deleteUser: ReturnType<typeof vi.fn> } } })
        .auth.admin.deleteUser,
    ).not.toHaveBeenCalled();
  });
});

// ── MCP connector endpoints (new in 1.0.10) ──────────────────────────────

describe("MCP connector routes", () => {
  beforeEach(() => {
    validateSupabaseTokenMock.mockResolvedValue({
      ok: true,
      principal: callerPrincipal,
    });
    createServerSupabaseMock.mockReturnValue({});
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
    expect(res.body.detail).toMatch(/mcp-connectors-encryption-key/);
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
    expect(res.text).toContain("access_denied");
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
    expect(res.body.detail).toMatch(/requires OAuth/);
  });

  it("refresh-tools maps other failures to 400", async () => {
    refreshUserMcpConnectorToolsMock.mockRejectedValueOnce(
      new Error("connection refused"),
    );

    const res = await request(makeApp())
      .post("/api/user/mcp-connectors/conn-1/refresh-tools")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(400);
    expect(res.body.detail).toBe("connection refused");
  });
});
