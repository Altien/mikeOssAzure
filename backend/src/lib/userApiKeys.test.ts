import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

const { getConfigMock, createServerSupabaseMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(),
  createServerSupabaseMock: vi.fn(),
}));

vi.mock("./config", () => ({
  getConfig: getConfigMock,
  flushConfigCache: vi.fn(),
}));

vi.mock("./supabase", () => ({
  createServerSupabase: createServerSupabaseMock,
}));

import {
  getUserApiKeys,
  setUserApiKey,
  deleteUserApiKey,
  getConfiguredProviders,
  flushEncryptionKey,
  _readLegacyRowForMigration,
} from "./userApiKeys";

/**
 * Build a fake supabase-style client with one method per code path the
 * tests exercise. Every method returns a promise so the same fluent
 * builder works whether the caller awaits `.eq()` or `.maybeSingle()`.
 */
type Result = { data?: unknown; error?: { message: string } | null };
function makeClient(opts: {
  apiKeysQuery?: Result;
  legacyMaybeSingle?: Result;
  upsert?: Result;
  delete?: Result;
}) {
  const upsert = vi.fn(() =>
    Promise.resolve(opts.upsert ?? { error: null }),
  );
  const eqDelete = vi.fn(() =>
    Promise.resolve(opts.delete ?? { error: null }),
  );

  const fromCalls: string[] = [];
  const upsertedRows: Array<Record<string, unknown>> = [];

  const client = {
    from: vi.fn((table: string) => {
      fromCalls.push(table);
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.eq = chain;
      builder.maybeSingle = () =>
        Promise.resolve(opts.legacyMaybeSingle ?? { data: null });
      // For api-keys queries the chain is itself awaited (no maybeSingle).
      builder.then = (
        onF: (v: Result) => unknown,
        onR?: (e: unknown) => unknown,
      ) =>
        Promise.resolve(
          table === "user_api_keys"
            ? (opts.apiKeysQuery ?? { data: [] })
            : { data: null },
        ).then(onF, onR);
      builder.upsert = vi.fn((row: Record<string, unknown>) => {
        upsertedRows.push(row);
        return upsert();
      });
      // delete().eq().eq() chain: delete returns the builder, which has eq.
      builder.delete = vi.fn(() => {
        const delBuilder: Record<string, unknown> = {};
        let calls = 0;
        delBuilder.eq = vi.fn(() => {
          calls += 1;
          // Only resolve after the second .eq() in the chain.
          return calls >= 2 ? eqDelete() : delBuilder;
        });
        return delBuilder;
      });
      return builder;
    }),
  };
  return { client, fromCalls, upsertedRows, upsert, eqDelete };
}

const SECRET = "test-encryption-secret-for-aes-gcm";
const envSnapshot = {} as Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot.NODE_ENV = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  getConfigMock.mockReset();
  getConfigMock.mockResolvedValue(SECRET);
  createServerSupabaseMock.mockReset();
  flushEncryptionKey();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  if (envSnapshot.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = envSnapshot.NODE_ENV;
});

describe("encryption key sourcing", () => {
  it("throws a descriptive error when getConfig returns an empty secret", async () => {
    getConfigMock.mockResolvedValueOnce("");
    const { client } = makeClient({ upsert: { error: null } });

    await expect(setUserApiKey("u1", "claude", "sk-1", client as never))
      .rejects.toThrow(/encryption secret.*is not configured/i);
  });

  it("caches the encryption key across calls — getConfig is hit once", async () => {
    const { client } = makeClient({ upsert: { error: null } });

    await setUserApiKey("u1", "claude", "sk-1", client as never);
    await setUserApiKey("u1", "gemini", "sk-2", client as never);
    await setUserApiKey("u1", "openai", "sk-3", client as never);

    expect(getConfigMock).toHaveBeenCalledTimes(1);
  });

  it("flushEncryptionKey forces a re-fetch on the next call (covers secret rotation)", async () => {
    const { client } = makeClient({ upsert: { error: null } });

    await setUserApiKey("u1", "claude", "sk-1", client as never);
    flushEncryptionKey();
    await setUserApiKey("u1", "gemini", "sk-2", client as never);

    expect(getConfigMock).toHaveBeenCalledTimes(2);
  });
});

describe("setUserApiKey — encryption invariants", () => {
  it("never sends the plaintext key to the database", async () => {
    const PLAINTEXT = "sk-very-secret-value";
    const { client, upsertedRows } = makeClient({ upsert: { error: null } });

    await setUserApiKey("u1", "claude", PLAINTEXT, client as never);

    expect(upsertedRows).toHaveLength(1);
    expect(JSON.stringify(upsertedRows[0])).not.toContain(PLAINTEXT);
    expect(upsertedRows[0]).toMatchObject({
      user_id: "u1",
      provider: "claude",
      encrypted_key: expect.any(String),
      iv: expect.any(String),
      auth_tag: expect.any(String),
    });
  });

  it("produces a different ciphertext+iv for the same plaintext on each call", async () => {
    const { client, upsertedRows } = makeClient({ upsert: { error: null } });

    await setUserApiKey("u1", "claude", "sk-same", client as never);
    await setUserApiKey("u1", "claude", "sk-same", client as never);

    expect(upsertedRows[0].encrypted_key).not.toBe(upsertedRows[1].encrypted_key);
    expect(upsertedRows[0].iv).not.toBe(upsertedRows[1].iv);
  });

  it("serialises an azure_openai object payload before encrypting it", async () => {
    const { client, upsertedRows } = makeClient({ upsert: { error: null } });

    await setUserApiKey(
      "u1",
      "azure_openai",
      {
        endpoint: "https://x.openai.azure.com",
        deployment: "gpt-5",
        apiKey: "azure-secret",
        apiVersion: "2024-02-15-preview",
      },
      client as never,
    );

    // Round-trip: read it back and the parser should reconstruct the object.
    const ciphertext = upsertedRows[0].encrypted_key as string;
    const iv = upsertedRows[0].iv as string;
    const authTag = upsertedRows[0].auth_tag as string;

    const { client: readClient } = makeClient({
      apiKeysQuery: {
        data: [
          { provider: "azure_openai", encrypted_key: ciphertext, iv, auth_tag: authTag },
        ],
      },
    });

    const keys = await getUserApiKeys("u1", readClient as never);

    expect(keys.azureOpenai).toEqual({
      endpoint: "https://x.openai.azure.com",
      deployment: "gpt-5",
      apiKey: "azure-secret",
      apiVersion: "2024-02-15-preview",
    });
  });

  it("throws when a non-azure provider is called with an object plaintext (shape mismatch)", async () => {
    const { client } = makeClient({});

    await expect(
      setUserApiKey(
        "u1",
        "claude",
        { endpoint: "x", deployment: "y" } as never,
        client as never,
      ),
    ).rejects.toThrow(/wrong plaintext shape for provider claude/);
  });

  it("throws with the provider in the message when the upsert errors", async () => {
    const { client } = makeClient({
      upsert: { error: { message: "permission denied" } },
    });

    await expect(setUserApiKey("u1", "openai", "sk", client as never))
      .rejects.toThrow(/Failed to set user_api_keys row for openai/);
  });

  it("uses onConflict='user_id,provider' so a second set replaces the first row", async () => {
    const { client } = makeClient({ upsert: { error: null } });
    let lastConflict: unknown;
    // Re-wire from() to capture the second argument to upsert.
    client.from = vi.fn(() => {
      const b: Record<string, unknown> = {};
      b.upsert = vi.fn((_row: unknown, opts: unknown) => {
        lastConflict = opts;
        return Promise.resolve({ error: null });
      });
      return b;
    });

    await setUserApiKey("u1", "claude", "sk", client as never);

    expect(lastConflict).toEqual({ onConflict: "user_id,provider" });
  });
});

describe("getUserApiKeys — decryption + fallback", () => {
  it("returns claude/gemini/openai/azureOpenai filled from decrypted rows", async () => {
    const { client: writeClient, upsertedRows } = makeClient({
      upsert: { error: null },
    });
    await setUserApiKey("u1", "claude", "sk-claude", writeClient as never);
    await setUserApiKey("u1", "gemini", "sk-gemini", writeClient as never);
    await setUserApiKey("u1", "openai", "sk-openai", writeClient as never);

    const rows = upsertedRows.map((r) => ({
      provider: r.provider,
      encrypted_key: r.encrypted_key,
      iv: r.iv,
      auth_tag: r.auth_tag,
    }));
    const { client: readClient } = makeClient({ apiKeysQuery: { data: rows } });

    const keys = await getUserApiKeys("u1", readClient as never);

    expect(keys).toEqual({
      claude: "sk-claude",
      gemini: "sk-gemini",
      openai: "sk-openai",
      // openrouter / courtlistener (44e868e) have no decrypted row, so they
      // fall back to the org-level secret via resolveSecret() → getConfig(),
      // which the test mocks to return SECRET for every name.
      openrouter: SECRET,
      courtlistener: SECRET,
      azureOpenai: null,
    });
  });

  it("skips a row whose ciphertext was tampered with rather than throwing", async () => {
    const { client: writeClient, upsertedRows } = makeClient({
      upsert: { error: null },
    });
    await setUserApiKey("u1", "claude", "sk-claude", writeClient as never);
    await setUserApiKey("u1", "openai", "sk-openai", writeClient as never);

    // Corrupt the claude row's auth tag — GCM decrypt will fail.
    const goodOpenAi = upsertedRows[1];
    const tampered = { ...upsertedRows[0], auth_tag: "AAAAAAAAAAAAAAAAAAAAAAAA" };
    const { client: readClient } = makeClient({
      apiKeysQuery: { data: [tampered, goodOpenAi] },
    });

    const keys = await getUserApiKeys("u1", readClient as never);

    expect(keys.claude).toBeNull();
    expect(keys.openai).toBe("sk-openai");
    expect(console.error).toHaveBeenCalledWith(
      "[userApiKeys] decryption failed",
      expect.objectContaining({ userId: "u1", provider: "claude" }),
    );
  });

  it("falls back to user_profiles legacy columns only when no encrypted row exists", async () => {
    const { client } = makeClient({
      apiKeysQuery: { data: [] },
      legacyMaybeSingle: {
        data: {
          claude_api_key: "legacy-claude",
          gemini_api_key: null,
          openai_api_key: "legacy-openai",
          azure_openai_endpoint: "https://legacy.openai.azure.com",
          azure_openai_api_key: "legacy-az",
          azure_openai_api_version: null,
          azure_openai_deployment: "gpt-3",
        },
      },
    });

    const keys = await getUserApiKeys("u1", client as never);

    expect(keys.claude).toBe("legacy-claude");
    expect(keys.openai).toBe("legacy-openai");
    expect(keys.gemini).toBeNull();
    expect(keys.azureOpenai).toEqual({
      endpoint: "https://legacy.openai.azure.com",
      deployment: "gpt-3",
      apiKey: "legacy-az",
      apiVersion: null,
    });
  });

  it("does NOT fall back to legacy when any encrypted row exists (avoid double-source confusion)", async () => {
    const { client: writeClient, upsertedRows } = makeClient({
      upsert: { error: null },
    });
    await setUserApiKey("u1", "claude", "sk-claude", writeClient as never);

    const { client: readClient, fromCalls } = makeClient({
      apiKeysQuery: { data: [upsertedRows[0]] },
      legacyMaybeSingle: {
        data: {
          claude_api_key: "DO-NOT-USE",
          gemini_api_key: "legacy-gem",
          openai_api_key: null,
          azure_openai_endpoint: null,
          azure_openai_api_key: null,
          azure_openai_api_version: null,
          azure_openai_deployment: null,
        },
      },
    });

    const keys = await getUserApiKeys("u1", readClient as never);

    expect(keys.claude).toBe("sk-claude");
    expect(keys.gemini).toBeNull();
    expect(fromCalls).toEqual(["user_api_keys"]);
  });

  it("treats a legacy azure row without endpoint+deployment as null (incomplete config)", async () => {
    const { client } = makeClient({
      apiKeysQuery: { data: [] },
      legacyMaybeSingle: {
        data: {
          claude_api_key: null,
          gemini_api_key: null,
          openai_api_key: null,
          azure_openai_endpoint: "https://x.openai.azure.com",
          azure_openai_api_key: "key",
          azure_openai_api_version: null,
          azure_openai_deployment: null,
        },
      },
    });

    const keys = await getUserApiKeys("u1", client as never);

    expect(keys.azureOpenai).toBeNull();
  });

  it("returns null for an azure_openai row whose decrypted blob is not valid JSON", async () => {
    const { client: writeClient, upsertedRows } = makeClient({
      upsert: { error: null },
    });
    // Setting azure_openai with a bare string bypasses the structured
    // serialiser. The decoded blob will fail JSON.parse → null.
    await setUserApiKey(
      "u1",
      "azure_openai",
      "not-an-object" as never,
      writeClient as never,
    );

    const { client: readClient } = makeClient({
      apiKeysQuery: {
        data: [
          {
            provider: "azure_openai",
            encrypted_key: upsertedRows[0].encrypted_key,
            iv: upsertedRows[0].iv,
            auth_tag: upsertedRows[0].auth_tag,
          },
        ],
      },
    });

    const keys = await getUserApiKeys("u1", readClient as never);

    expect(keys.azureOpenai).toBeNull();
  });

  it("returns null azure_openai when the JSON blob is missing endpoint or deployment", async () => {
    const { client: writeClient, upsertedRows } = makeClient({
      upsert: { error: null },
    });
    await setUserApiKey(
      "u1",
      "azure_openai",
      JSON.stringify({ key: "k" }) as never,
      writeClient as never,
    );

    const { client: readClient } = makeClient({
      apiKeysQuery: {
        data: [
          {
            provider: "azure_openai",
            encrypted_key: upsertedRows[0].encrypted_key,
            iv: upsertedRows[0].iv,
            auth_tag: upsertedRows[0].auth_tag,
          },
        ],
      },
    });

    const keys = await getUserApiKeys("u1", readClient as never);

    expect(keys.azureOpenai).toBeNull();
  });
});

describe("getUserApiKeys — error handling", () => {
  it("logs and still consults the legacy fallback when the encrypted-rows query errors", async () => {
    const { client } = makeClient({
      apiKeysQuery: {
        data: null,
        error: { message: "permission denied" },
      },
      legacyMaybeSingle: {
        data: {
          claude_api_key: "from-legacy",
          gemini_api_key: null,
          openai_api_key: null,
          azure_openai_endpoint: null,
          azure_openai_api_key: null,
          azure_openai_api_version: null,
          azure_openai_deployment: null,
        },
      },
    });

    const keys = await getUserApiKeys("u1", client as never);

    expect(keys.claude).toBe("from-legacy");
    expect(console.error).toHaveBeenCalledWith(
      "[userApiKeys] failed to read user_api_keys",
      expect.objectContaining({ userId: "u1", error: "permission denied" }),
    );
  });
});

describe("default db argument", () => {
  it("falls back to createServerSupabase when the caller passes no db", async () => {
    const { client } = makeClient({ apiKeysQuery: { data: [] } });
    createServerSupabaseMock.mockReturnValue(client);

    await getUserApiKeys("u1");
    await getConfiguredProviders("u1");
    await _readLegacyRowForMigration("u1");

    expect(createServerSupabaseMock).toHaveBeenCalledTimes(3);
  });
});

describe("azure_openai serialisation defaults", () => {
  it("stores null for apiKey and apiVersion when they're omitted from the input", async () => {
    const { client: writeClient, upsertedRows } = makeClient({
      upsert: { error: null },
    });
    await setUserApiKey(
      "u1",
      "azure_openai",
      { endpoint: "ep", deployment: "dep" },
      writeClient as never,
    );

    const { client: readClient } = makeClient({
      apiKeysQuery: {
        data: [
          {
            provider: "azure_openai",
            encrypted_key: upsertedRows[0].encrypted_key,
            iv: upsertedRows[0].iv,
            auth_tag: upsertedRows[0].auth_tag,
          },
        ],
      },
    });

    const keys = await getUserApiKeys("u1", readClient as never);

    expect(keys.azureOpenai).toEqual({
      endpoint: "ep",
      deployment: "dep",
      apiKey: null,
      apiVersion: null,
    });
  });
});

describe("deleteUserApiKey", () => {
  it("scopes the delete to user_id AND provider — never deletes another user's row", async () => {
    let firstEq: [string, unknown] | undefined;
    let secondEq: [string, unknown] | undefined;
    const client = {
      from: vi.fn(() => {
        let calls = 0;
        const b: Record<string, unknown> = {};
        const delB: Record<string, unknown> = {};
        delB.eq = vi.fn((col: string, val: unknown) => {
          calls += 1;
          if (calls === 1) firstEq = [col, val];
          else secondEq = [col, val];
          return calls >= 2
            ? Promise.resolve({ error: null })
            : delB;
        });
        b.delete = vi.fn(() => delB);
        return b;
      }),
    };

    await deleteUserApiKey("u1", "claude", client as never);

    expect(firstEq).toEqual(["user_id", "u1"]);
    expect(secondEq).toEqual(["provider", "claude"]);
  });

  it("throws with the provider in the message when the delete errors", async () => {
    const client = {
      from: vi.fn(() => {
        const b: Record<string, unknown> = {};
        const delB: Record<string, unknown> = {};
        let calls = 0;
        delB.eq = vi.fn(() => {
          calls += 1;
          return calls >= 2
            ? Promise.resolve({ error: { message: "fk violation" } })
            : delB;
        });
        b.delete = vi.fn(() => delB);
        return b;
      }),
    };

    await expect(deleteUserApiKey("u1", "gemini", client as never))
      .rejects.toThrow(/Failed to delete user_api_keys row for gemini/);
  });
});

describe("getConfiguredProviders", () => {
  it("returns true for each provider that has an encrypted row", async () => {
    const { client } = makeClient({
      apiKeysQuery: {
        data: [{ provider: "claude" }, { provider: "azure_openai" }],
      },
    });

    const result = await getConfiguredProviders("u1", client as never);

    expect(result).toEqual({
      claude: true,
      gemini: false,
      openai: false,
      openrouter: false,
      courtlistener: false,
      azure_openai: true,
    });
  });

  it("falls back to legacy columns only when no encrypted rows exist", async () => {
    const { client } = makeClient({
      apiKeysQuery: { data: [] },
      legacyMaybeSingle: {
        data: {
          claude_api_key: "k",
          gemini_api_key: null,
          openai_api_key: "k",
          azure_openai_endpoint: "ep",
          azure_openai_api_key: null,
          azure_openai_api_version: null,
          azure_openai_deployment: "dep",
        },
      },
    });

    const result = await getConfiguredProviders("u1", client as never);

    expect(result).toEqual({
      claude: true,
      gemini: false,
      openai: true,
      openrouter: false,
      courtlistener: false,
      azure_openai: true,
    });
  });

  it("returns all-false when no rows and no legacy data exist", async () => {
    const { client } = makeClient({
      apiKeysQuery: { data: [] },
      legacyMaybeSingle: { data: null },
    });

    const result = await getConfiguredProviders("u1", client as never);

    expect(result).toEqual({
      claude: false,
      gemini: false,
      openai: false,
      openrouter: false,
      courtlistener: false,
      azure_openai: false,
    });
  });
});

describe("_readLegacyRowForMigration", () => {
  it("returns the row when present", async () => {
    const data = {
      claude_api_key: "ck",
      gemini_api_key: null,
      openai_api_key: null,
      azure_openai_endpoint: null,
      azure_openai_api_key: null,
      azure_openai_api_version: null,
      azure_openai_deployment: null,
    };
    const { client } = makeClient({ legacyMaybeSingle: { data } });

    const result = await _readLegacyRowForMigration("u1", client as never);

    expect(result).toEqual(data);
  });

  it("returns null when there's no row for the user", async () => {
    const { client } = makeClient({ legacyMaybeSingle: { data: null } });

    const result = await _readLegacyRowForMigration("u1", client as never);

    expect(result).toBeNull();
  });
});
