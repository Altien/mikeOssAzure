import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

const { readEncryptedApiKeysMock, createServerSupabaseMock } = vi.hoisted(() => ({
  readEncryptedApiKeysMock: vi.fn(),
  createServerSupabaseMock: vi.fn(),
}));

vi.mock("./userApiKeys", () => ({
  getUserApiKeys: readEncryptedApiKeysMock,
}));

vi.mock("./supabase", () => ({
  createServerSupabase: createServerSupabaseMock,
}));

// `resolveModel` is the only thing we actually rely on from ./llm beyond
// the constants; mock it so we control the allow-list deterministically.
vi.mock("./llm", () => ({
  resolveModel: (id: string | null | undefined, fallback: string) =>
    id && id !== "blocked-model" ? id : fallback,
  DEFAULT_TITLE_MODEL: "default-title-model",
  DEFAULT_TABULAR_MODEL: "default-tabular-model",
  OPENAI_LOW_MODELS: ["gpt-5.4-lite"],
}));

import {
  getUserModelSettings,
  getUserApiKeys,
  upsertUserProfile,
} from "./userSettings";

/**
 * Tiny chainable fake for the two-phase upsertUserProfile flow and the
 * single-row select used by getUserModelSettings.
 *
 * For each table the caller queues per-action results:
 *   { selectMaybeSingle, selectSingle, insert, update }
 * Each action records its arguments into `calls` so tests can assert on
 * the payload sent to the DB.
 */
type Result = { data?: unknown; error?: { message: string } | null };
type Action =
  | { type: "select"; cols: string }
  | { type: "eq"; col: string; val: unknown }
  | { type: "maybeSingle" }
  | { type: "single" }
  | { type: "insert"; row: unknown }
  | { type: "update"; patch: unknown };

function makeClient(opts: {
  selectMaybeSingle?: Result;
  selectSingle?: Result;
  insert?: Result;
  update?: Result;
}) {
  const calls: Action[] = [];
  const client = {
    from: vi.fn((_table: string) => {
      const b: Record<string, unknown> = {};
      b.select = vi.fn((cols: string) => {
        calls.push({ type: "select", cols });
        return b;
      });
      b.eq = vi.fn((col: string, val: unknown) => {
        calls.push({ type: "eq", col, val });
        return b;
      });
      b.maybeSingle = vi.fn(() => {
        calls.push({ type: "maybeSingle" });
        return Promise.resolve(opts.selectMaybeSingle ?? { data: null });
      });
      b.single = vi.fn(() => {
        calls.push({ type: "single" });
        return Promise.resolve(opts.selectSingle ?? { data: null });
      });
      b.insert = vi.fn((row: unknown) => {
        calls.push({ type: "insert", row });
        return Promise.resolve(opts.insert ?? { error: null });
      });
      // For update().eq() the eq is the terminator, so swap eq() behaviour
      // after update() is called.
      b.update = vi.fn((patch: unknown) => {
        calls.push({ type: "update", patch });
        const updB: Record<string, unknown> = {};
        updB.eq = vi.fn((col: string, val: unknown) => {
          calls.push({ type: "eq", col, val });
          return Promise.resolve(opts.update ?? { error: null });
        });
        return updB;
      });
      return b;
    }),
  };
  return { client, calls };
}

const emptyKeys = {
  claude: null,
  gemini: null,
  openai: null,
  azureOpenai: null,
};

const envSnapshot = {} as Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot.AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT;
  delete process.env.AZURE_OPENAI_DEPLOYMENT;
  readEncryptedApiKeysMock.mockReset();
  createServerSupabaseMock.mockReset();
});

afterEach(() => {
  if (envSnapshot.AZURE_OPENAI_DEPLOYMENT === undefined) {
    delete process.env.AZURE_OPENAI_DEPLOYMENT;
  } else {
    process.env.AZURE_OPENAI_DEPLOYMENT = envSnapshot.AZURE_OPENAI_DEPLOYMENT;
  }
});

describe("getUserModelSettings — fast model resolution chain", () => {
  it("uses an explicit fast_model preference when it's set and non-empty", async () => {
    readEncryptedApiKeysMock.mockResolvedValueOnce({
      ...emptyKeys,
      gemini: "sk-gem",
    });
    const { client } = makeClient({
      selectSingle: { data: { fast_model: "user-pick", tabular_model: null } },
    });

    const result = await getUserModelSettings("u1", client as never);

    expect(result.fast_model).toBe("user-pick");
  });

  it("trims whitespace from an explicit preference and treats whitespace-only as absent", async () => {
    readEncryptedApiKeysMock.mockResolvedValueOnce({
      ...emptyKeys,
      gemini: "sk-gem",
    });
    const { client } = makeClient({
      selectSingle: { data: { fast_model: "   ", tabular_model: null } },
    });

    const result = await getUserModelSettings("u1", client as never);

    expect(result.fast_model).toBe("default-title-model");
  });

  it("falls back to gemini's default title model when only gemini is configured", async () => {
    readEncryptedApiKeysMock.mockResolvedValueOnce({
      ...emptyKeys,
      gemini: "sk-gem",
    });
    const { client } = makeClient({
      selectSingle: { data: { fast_model: null, tabular_model: null } },
    });

    const result = await getUserModelSettings("u1", client as never);

    expect(result.fast_model).toBe("default-title-model");
  });

  it("falls back to the OpenAI low-tier model when only openai is configured", async () => {
    readEncryptedApiKeysMock.mockResolvedValueOnce({
      ...emptyKeys,
      openai: "sk-oa",
    });
    const { client } = makeClient({
      selectSingle: { data: { fast_model: null, tabular_model: null } },
    });

    const result = await getUserModelSettings("u1", client as never);

    expect(result.fast_model).toBe("gpt-5.4-lite");
  });

  it("falls back to claude-haiku-4-5 when only claude is configured", async () => {
    readEncryptedApiKeysMock.mockResolvedValueOnce({
      ...emptyKeys,
      claude: "sk-cl",
    });
    const { client } = makeClient({
      selectSingle: { data: { fast_model: null, tabular_model: null } },
    });

    const result = await getUserModelSettings("u1", client as never);

    expect(result.fast_model).toBe("claude-haiku-4-5");
  });

  it("falls back to aoai:<deployment> when only the user's azure_openai deployment is set", async () => {
    readEncryptedApiKeysMock.mockResolvedValueOnce({
      ...emptyKeys,
      azureOpenai: {
        endpoint: "ep",
        deployment: "my-deploy",
        apiKey: null,
        apiVersion: null,
      },
    });
    const { client } = makeClient({
      selectSingle: { data: { fast_model: null, tabular_model: null } },
    });

    const result = await getUserModelSettings("u1", client as never);

    expect(result.fast_model).toBe("aoai:my-deploy");
  });

  it("falls back to the AZURE_OPENAI_DEPLOYMENT env when the user has no azure deployment", async () => {
    process.env.AZURE_OPENAI_DEPLOYMENT = "env-deploy";
    readEncryptedApiKeysMock.mockResolvedValueOnce(emptyKeys);
    const { client } = makeClient({
      selectSingle: { data: { fast_model: null, tabular_model: null } },
    });

    const result = await getUserModelSettings("u1", client as never);

    expect(result.fast_model).toBe("aoai:env-deploy");
  });

  it("returns DEFAULT_TITLE_MODEL when no providers are configured anywhere", async () => {
    readEncryptedApiKeysMock.mockResolvedValueOnce(emptyKeys);
    const { client } = makeClient({
      selectSingle: { data: { fast_model: null, tabular_model: null } },
    });

    const result = await getUserModelSettings("u1", client as never);

    expect(result.fast_model).toBe("default-title-model");
  });

  it("provider chain priority: gemini > openai > claude > azure", async () => {
    readEncryptedApiKeysMock.mockResolvedValueOnce({
      gemini: "g",
      openai: "o",
      claude: "c",
      azureOpenai: {
        endpoint: "ep",
        deployment: "d",
        apiKey: null,
        apiVersion: null,
      },
    });
    const { client } = makeClient({
      selectSingle: { data: { fast_model: null, tabular_model: null } },
    });

    const result = await getUserModelSettings("u1", client as never);

    expect(result.fast_model).toBe("default-title-model");
  });
});

describe("getUserModelSettings — tabular model & api_keys", () => {
  it("resolves tabular_model via resolveModel with DEFAULT_TABULAR_MODEL fallback", async () => {
    readEncryptedApiKeysMock.mockResolvedValueOnce(emptyKeys);
    const { client } = makeClient({
      selectSingle: {
        data: { fast_model: null, tabular_model: "blocked-model" },
      },
    });

    const result = await getUserModelSettings("u1", client as never);

    expect(result.tabular_model).toBe("default-tabular-model");
  });

  it("preserves an allow-listed tabular_model selection", async () => {
    readEncryptedApiKeysMock.mockResolvedValueOnce(emptyKeys);
    const { client } = makeClient({
      selectSingle: {
        data: { fast_model: null, tabular_model: "allowed-model" },
      },
    });

    const result = await getUserModelSettings("u1", client as never);

    expect(result.tabular_model).toBe("allowed-model");
  });

  it("includes the raw api_keys object on the response", async () => {
    const apiKeys = { ...emptyKeys, claude: "sk-cl" };
    readEncryptedApiKeysMock.mockResolvedValueOnce(apiKeys);
    const { client } = makeClient({
      selectSingle: { data: { fast_model: null, tabular_model: null } },
    });

    const result = await getUserModelSettings("u1", client as never);

    expect(result.api_keys).toEqual(apiKeys);
  });

  it("uses createServerSupabase when no db is passed", async () => {
    readEncryptedApiKeysMock.mockResolvedValueOnce(emptyKeys);
    const { client } = makeClient({
      selectSingle: { data: { fast_model: null, tabular_model: null } },
    });
    createServerSupabaseMock.mockReturnValue(client);

    await getUserModelSettings("u1");

    expect(createServerSupabaseMock).toHaveBeenCalledTimes(1);
  });
});

describe("getUserApiKeys — thin wrapper", () => {
  it("delegates to userApiKeys.getUserApiKeys with the provided client", async () => {
    const keys = { ...emptyKeys, claude: "sk-c" };
    readEncryptedApiKeysMock.mockResolvedValueOnce(keys);
    const { client } = makeClient({});

    const result = await getUserApiKeys("u1", client as never);

    expect(result).toBe(keys);
    expect(readEncryptedApiKeysMock).toHaveBeenCalledWith("u1", client);
  });

  it("creates a server client when none is passed", async () => {
    readEncryptedApiKeysMock.mockResolvedValueOnce(emptyKeys);
    const { client } = makeClient({});
    createServerSupabaseMock.mockReturnValue(client);

    await getUserApiKeys("u1");

    expect(createServerSupabaseMock).toHaveBeenCalled();
    expect(readEncryptedApiKeysMock).toHaveBeenCalledWith("u1", client);
  });
});

describe("upsertUserProfile — defaults", () => {
  it("creates a server client when called without a db argument", async () => {
    const { client } = makeClient({
      selectMaybeSingle: { data: null },
      insert: { error: null },
    });
    createServerSupabaseMock.mockReturnValue(client);

    await upsertUserProfile("u1", "x@y.z", null);

    expect(createServerSupabaseMock).toHaveBeenCalledTimes(1);
  });
});

describe("upsertUserProfile — new-user insert", () => {
  it("INSERTs with lowercased email and trimmed display name when no row exists", async () => {
    const { client, calls } = makeClient({
      selectMaybeSingle: { data: null },
      insert: { error: null },
    });

    await upsertUserProfile(
      "u1",
      "  Caller@Example.COM  ",
      "  Ada Lovelace  ",
      client as never,
    );

    const insertCall = calls.find((c) => c.type === "insert");
    expect(insertCall).toEqual({
      type: "insert",
      row: {
        user_id: "u1",
        email: "caller@example.com",
        display_name: "Ada Lovelace",
      },
    });
  });

  it("stores null email and null display_name when both inputs are empty/whitespace", async () => {
    const { client, calls } = makeClient({
      selectMaybeSingle: { data: null },
      insert: { error: null },
    });

    await upsertUserProfile("u1", "   ", "   ", client as never);

    const insertCall = calls.find((c) => c.type === "insert");
    expect(insertCall).toEqual({
      type: "insert",
      row: { user_id: "u1", email: null, display_name: null },
    });
  });

  it("throws with the DB message when the insert fails", async () => {
    const { client } = makeClient({
      selectMaybeSingle: { data: null },
      insert: { error: { message: "unique violation on email" } },
    });

    await expect(
      upsertUserProfile("u1", "x@y.z", "X", client as never),
    ).rejects.toThrow(/Failed to create user profile: unique violation on email/);
  });
});

describe("upsertUserProfile — returning-user update", () => {
  it("UPDATEs the email when the IdP-provided value differs from what's stored", async () => {
    const { client, calls } = makeClient({
      selectMaybeSingle: {
        data: { email: "old@example.com", display_name: "User" },
      },
      update: { error: null },
    });

    await upsertUserProfile(
      "u1",
      "New@Example.COM",
      "User Changed Their Name",
      client as never,
    );

    const updateCall = calls.find((c) => c.type === "update");
    expect(updateCall).toEqual({
      type: "update",
      patch: { email: "new@example.com" },
    });
  });

  it("does NOT touch the database when email and display_name are already up to date", async () => {
    const { client, calls } = makeClient({
      selectMaybeSingle: {
        data: { email: "caller@example.com", display_name: "Caller" },
      },
    });

    await upsertUserProfile(
      "u1",
      "caller@example.com",
      "Different Name From IdP",
      client as never,
    );

    expect(calls.find((c) => c.type === "update")).toBeUndefined();
    expect(calls.find((c) => c.type === "insert")).toBeUndefined();
  });

  it("back-fills display_name only when the stored value is null or whitespace", async () => {
    const { client: nullClient, calls: nullCalls } = makeClient({
      selectMaybeSingle: {
        data: { email: "x@y.z", display_name: null },
      },
      update: { error: null },
    });
    await upsertUserProfile("u1", "x@y.z", "IdP Name", nullClient as never);
    expect(
      nullCalls.find((c) => c.type === "update"),
    ).toEqual({ type: "update", patch: { display_name: "IdP Name" } });

    const { client: emptyClient, calls: emptyCalls } = makeClient({
      selectMaybeSingle: {
        data: { email: "x@y.z", display_name: "  " },
      },
      update: { error: null },
    });
    await upsertUserProfile("u1", "x@y.z", "IdP Name", emptyClient as never);
    expect(
      emptyCalls.find((c) => c.type === "update"),
    ).toEqual({ type: "update", patch: { display_name: "IdP Name" } });
  });

  it("NEVER overwrites a non-empty stored display_name (user's choice wins over IdP)", async () => {
    const { client, calls } = makeClient({
      selectMaybeSingle: {
        data: { email: "x@y.z", display_name: "User-Picked Name" },
      },
      update: { error: null },
    });

    await upsertUserProfile("u1", "x@y.z", "IdP Wants This", client as never);

    expect(calls.find((c) => c.type === "update")).toBeUndefined();
  });

  it("scopes the UPDATE to user_id", async () => {
    const { client, calls } = makeClient({
      selectMaybeSingle: { data: { email: "old@y.z", display_name: "U" } },
      update: { error: null },
    });

    await upsertUserProfile("u1", "new@y.z", "U", client as never);

    const eqs = calls.filter((c) => c.type === "eq");
    expect(eqs.some((c) => c.col === "user_id" && c.val === "u1")).toBe(true);
  });

  it("throws when the SELECT errors", async () => {
    const { client } = makeClient({
      selectMaybeSingle: { data: null, error: { message: "db down" } },
    });

    await expect(upsertUserProfile("u1", "x@y.z", null, client as never))
      .rejects.toThrow(/Failed to read user profile: db down/);
  });

  it("throws when the UPDATE errors", async () => {
    const { client } = makeClient({
      selectMaybeSingle: { data: { email: "old@y.z", display_name: null } },
      update: { error: { message: "tx conflict" } },
    });

    await expect(upsertUserProfile("u1", "new@y.z", "X", client as never))
      .rejects.toThrow(/Failed to update user profile: tx conflict/);
  });
});
