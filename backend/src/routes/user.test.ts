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
} = vi.hoisted(() => ({
  validateSupabaseTokenMock: vi.fn(),
  validateLocalTokenMock: vi.fn(),
  validateEntraTokenMock: vi.fn(),
  upsertUserProfileMock: vi.fn(),
  createServerSupabaseMock: vi.fn(),
  getUserApiKeysMock: vi.fn(),
  setUserApiKeyMock: vi.fn(),
  deleteUserApiKeyMock: vi.fn(),
}));

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
      openai: true,
      // openrouter / courtlistener added by upstream 44e868e; neither
      // env var is set in this test, so both resolve to false.
      openrouter: false,
      courtlistener: false,
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

  // The inline FK-safe cascade the older tests asserted on has moved into
  // lib/userDataCleanup's deleteUserAccountData (sync-log 3a10943). That
  // helper uses .in()/.filter() and parallel deletes the makeDb() fake
  // above can't model, so account-deletion tests use this richer fake. It
  // records every .delete() target table, lets a specific table's delete
  // fail, and exposes the db.auth.admin.deleteUser the route now calls in
  // supabase mode.
  function makeAccountDb(opts: {
    deleteError?: { table: string; message: string };
    authDeleteError?: { message: string } | null;
  } = {}) {
    const deletes: string[] = [];
    const authDeleteUser = vi.fn(async () => ({
      error: opts.authDeleteError ?? null,
    }));
    const db = {
      from: vi.fn((table: string) => {
        const b: Record<string, unknown> = {};
        let op: "select" | "delete" | "update" = "select";
        b.select = () => {
          op = "select";
          return b;
        };
        b.update = () => {
          op = "update";
          return b;
        };
        b.delete = () => {
          op = "delete";
          return b;
        };
        const resolve = () => {
          if (op === "delete") {
            if (opts.deleteError && opts.deleteError.table === table) {
              return Promise.resolve({
                data: null,
                error: { message: opts.deleteError.message },
              });
            }
            deletes.push(table);
            return Promise.resolve({ data: null, error: null });
          }
          // selects (and the rare merge update) return an empty result set,
          // so the cleanup helper has no ids/rows to fan out to.
          return Promise.resolve({ data: [], error: null });
        };
        // Every terminator the helper awaits resolves to a result.
        b.eq = () => resolve();
        b.in = () => resolve();
        b.filter = () => resolve();
        return b;
      }),
      auth: { admin: { deleteUser: authDeleteUser } },
    };
    return { db, deletes, authDeleteUser };
  }

  it("cascades through deleteUserAccountData, removes the identity tables, then 204s", async () => {
    const { db, deletes, authDeleteUser } = makeAccountDb();
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .delete("/api/user/account")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(204);
    // The route deletes the identity-adjacent tables itself after the
    // cleanup helper runs, then removes the auth user (supabase mode).
    expect(deletes).toContain("user_api_keys");
    expect(deletes).toContain("user_profiles");
    expect(authDeleteUser).toHaveBeenCalledWith("user-1");
  });

  it("returns 500 with the table name when an identity-table delete fails", async () => {
    // The route's own loop over [user_api_keys, user_profiles] still emits
    // the "Failed to delete user data from <table>" message.
    const { db, authDeleteUser } = makeAccountDb({
      deleteError: { table: "user_profiles", message: "deadlock" },
    });
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .delete("/api/user/account")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(500);
    expect(res.body.detail).toBe(
      "Failed to delete user data from user_profiles: deadlock",
    );
    // Bailed before removing the auth identity.
    expect(authDeleteUser).not.toHaveBeenCalled();
  });

  it("returns 500 when a delete inside the account-data cleanup fails", async () => {
    // workflow_shares cleanup now lives inside deleteUserAccountData, which
    // surfaces failures via the generic "Failed to delete account data" context.
    const { db, authDeleteUser } = makeAccountDb({
      deleteError: { table: "workflow_shares", message: "permission denied" },
    });
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .delete("/api/user/account")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(500);
    expect(res.body.detail).toBe(
      "Failed to delete account data: permission denied",
    );
    expect(authDeleteUser).not.toHaveBeenCalled();
  });

  it("skips the email-based workflow_shares cleanup when the principal has no email claim", async () => {
    validateSupabaseTokenMock.mockResolvedValueOnce({
      ok: true,
      principal: { ...callerPrincipal, email: "" },
    });
    const { db, deletes } = makeAccountDb();
    createServerSupabaseMock.mockReturnValue(db);

    const res = await request(makeApp())
      .delete("/api/user/account")
      .set("Authorization", "Bearer ok");

    expect(res.status).toBe(204);
    // workflow_shares is still cleared once by shared_by_user_id, but the
    // second, email-keyed delete (shared_with_email) is skipped — so the
    // table is touched exactly once rather than twice.
    const shareDeletes = deletes.filter((t) => t === "workflow_shares");
    expect(shareDeletes).toHaveLength(1);
  });
});
