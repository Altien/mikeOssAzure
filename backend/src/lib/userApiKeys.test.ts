import crypto from "node:crypto";
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

const { getConfigMock, createServerSupabaseMock, managedSecrets, resolveManagedSecretMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(),
  createServerSupabaseMock: vi.fn(),
  managedSecrets: new Map<string, string>(),
  resolveManagedSecretMock: vi.fn(),
}));

vi.mock("./config", () => ({
  getConfig: getConfigMock,
  getKeyVaultConfig: getConfigMock,
  flushConfigCache: vi.fn(),
}));

vi.mock("./supabase", () => ({
  createServerSupabase: createServerSupabaseMock,
}));

// Dev drift: execution credentials are managed; storage helpers remain internal.
vi.mock("./envSecrets", () => ({
  resolveSecret: resolveManagedSecretMock,
  resolveProviderSecret: resolveManagedSecretMock,
  resolveVercelApiKey: () => resolveManagedSecretMock("ai-gateway-api-key"),
}));
vi.mock("./llm/cloudProviders", () => ({
  envBedrockCredentials: vi.fn(async () => null),
  envAzureCredentials: vi.fn(async () => null),
  envAzureFoundryCredentials: vi.fn(async () => null),
  envVertexCredentials: vi.fn(async () => null),
  envVertexServiceAccountKey: vi.fn(async () => ""),
  envCustomEndpointCredentials: vi.fn(async () => null),
}));
vi.mock("./webSearch/credentials", () => ({
  loadDeploymentSearchApiKeys: vi.fn(async () => ({ brave: null, tavily: null, deepseek: null })),
}));

import {
  getUserApiKeys,
  setUserApiKey,
  deleteUserApiKey,
  getConfiguredProviders,
  flushEncryptionKey,
  _readLegacyRowForMigration,
  getOrganisationApiKeys,
} from "../modules/user/user.apiKeyStore"; // Dev drift: moved by upstream #295

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
      builder.filter = chain;
      builder.is = chain;
      builder.maybeSingle = () =>
        Promise.resolve(table === "user_courtlistener_connections"
          ? { data: { enabled: true, token: null } }
          : (opts.legacyMaybeSingle ?? { data: null }));
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
// Verify encrypted storage independently of the intentionally managed execution read path.
function decryptStored(row: Record<string, unknown>): string {
  const key = crypto.createHash("sha256").update(SECRET).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv as string, "base64"));
  decipher.setAuthTag(Buffer.from(row.auth_tag as string, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(row.encrypted_key as string, "base64")), decipher.final()]).toString("utf8");
}

const envSnapshot = {} as Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot.NODE_ENV = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  getConfigMock.mockReset();
  managedSecrets.clear();
  resolveManagedSecretMock.mockReset();
  resolveManagedSecretMock.mockImplementation(async (name: string) => managedSecrets.get(name) ?? "");
  // Name-aware: only the encryption key resolves. Dev's openrouter /
  // courtlistener global fallbacks (resolveSecret → getConfig) must see
  // "not configured", or every test would find phantom keys for them.
  getConfigMock.mockImplementation((name: string) =>
    name === "user-api-keys-encryption-key"
      ? Promise.resolve(SECRET)
      : Promise.reject(new Error(`no config for ${name} in tests`)),
  );
  createServerSupabaseMock.mockReset();
  flushEncryptionKey();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (envSnapshot.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = envSnapshot.NODE_ENV;
});

describe("encryption key sourcing", () => {
  it("identifies the required secret when config resolution fails", async () => {
    getConfigMock.mockRejectedValueOnce(new Error("SecretNotFound"));
    const { client } = makeClient({ upsert: { error: null } });

    await expect(setUserApiKey("u1", "courtlistener", "token", client as never))
      .rejects.toThrow(
        /user-api-keys-encryption-key.*could not be loaded.*SecretNotFound/i,
      );
  });

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

describe("organisation provider credentials", () => {
  it("resolves every shared provider from its canonical Key Vault name", async () => {
    const values: Record<string, string> = {
      "anthropic-api-key": "org-anthropic",
      "gemini-api-key": "org-gemini",
      "openai-api-key": "org-openai",
      "moonshot-api-key": "org-kimi",
      "mistral-api-key": "org-mistral",
      "openrouter-api-key": "org-openrouter",
      "ai-gateway-api-key": "org-vercel",
      "opencode-api-key": "org-opencode",
      "courtlistener-api-token": "org-courtlistener",
      "azure-openai-endpoint": "https://org.openai.azure.com",
      "azure-openai-api-key": "org-azure",
      "azure-openai-api-version": "2024-10-21",
      "azure-openai-deployment": "org-deployment",
    };
    vi.stubEnv("KEY_VAULT_NAME", "test-vault");
    for (const [name, value] of Object.entries(values)) managedSecrets.set(name, value);

    await expect(getOrganisationApiKeys()).resolves.toMatchObject({
      claude: "org-anthropic",
      gemini: "org-gemini",
      openai: "org-openai",
      kimi: "org-kimi",
      mistral: "org-mistral",
      openrouter: "org-openrouter",
      vercel: "org-vercel",
      "opencode-go": "org-opencode",
      courtlistener: "org-courtlistener",
      azureOpenai: {
        endpoint: "https://org.openai.azure.com",
        apiKey: "org-azure",
        apiVersion: "2024-10-21",
        deployment: "org-deployment",
      },
    });
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
    await setUserApiKey("u1", "azure_openai", {
      endpoint: "https://x.openai.azure.com", deployment: "gpt-5",
      apiKey: "azure-secret", apiVersion: "2024-02-15-preview",
    }, client as never);
    expect(JSON.parse(decryptStored(upsertedRows[0]!))).toEqual({
      endpoint: "https://x.openai.azure.com", deployment: "gpt-5",
      key: "azure-secret", version: "2024-02-15-preview",
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

describe("getUserApiKeys — managed execution credentials", () => {
  // Dev drift: the old personal-decryption/fallback scenarios are now refusal boundaries.
  const scenarios: Array<[string, Parameters<typeof makeClient>[0]]> = [
    ["does not execute encrypted personal keys", { apiKeysQuery: { data: [{ provider: "claude", encrypted_key: "personal-secret" }] } }],
    ["does not decrypt a tampered personal row", { apiKeysQuery: { data: [{ provider: "claude", auth_tag: "tampered" }] } }],
    ["does not execute legacy profile plaintext", { legacyMaybeSingle: { data: { claude_api_key: "legacy-secret" } } }],
    ["does not combine encrypted and legacy personal sources", { apiKeysQuery: { data: [{ provider: "claude" }] }, legacyMaybeSingle: { data: { gemini_api_key: "legacy-secret" } } }],
    ["does not execute an incomplete legacy Azure configuration", { legacyMaybeSingle: { data: { azure_openai_endpoint: "https://legacy.openai.azure.com", azure_openai_api_key: "legacy-secret" } } }],
    ["does not parse a personal Azure non-JSON blob", { apiKeysQuery: { data: [{ provider: "azure_openai", encrypted_key: "not-json" }] } }],
    ["does not execute a personal Azure blob missing deployment", { apiKeysQuery: { data: [{ provider: "azure_openai", encrypted_key: "missing-deployment" }] } }],
  ];
  it.each(scenarios)("%s", async (_label, options) => {
    for (const [name, value] of Object.entries({
      "anthropic-api-key": "managed-claude", "gemini-api-key": "managed-gemini",
      "openai-api-key": "managed-openai", "azure-openai-endpoint": "https://managed.openai.azure.com",
      "azure-openai-api-key": "managed-azure", "azure-openai-deployment": "managed-deployment",
    })) managedSecrets.set(name, value);
    const { client, fromCalls } = makeClient(options);
    const keys = await getUserApiKeys("u1", client as never);
    expect(keys).toMatchObject({
      claude: "managed-claude", gemini: "managed-gemini", openai: "managed-openai",
      azureOpenai: { endpoint: "https://managed.openai.azure.com", apiKey: "managed-azure", deployment: "managed-deployment" },
    });
    expect(fromCalls).toEqual(["user_profiles", "user_courtlistener_connections"]);
    expect(fromCalls).not.toContain("user_api_keys");
  });
});

describe("getUserApiKeys — error handling", () => {
  it("uses managed credentials without consulting an unreadable personal secret table", async () => {
    managedSecrets.set("anthropic-api-key", "managed-claude");
    const { client, fromCalls } = makeClient({
      apiKeysQuery: { data: null, error: { message: "permission denied" } },
      legacyMaybeSingle: { data: { claude_api_key: "legacy-secret" } },
    });
    const keys = await getUserApiKeys("u1", client as never);
    expect(keys.claude).toBe("managed-claude");
    expect(fromCalls).not.toContain("user_api_keys");
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
  it("stores null for apiKey and apiVersion when omitted from internal storage input", async () => {
    const { client, upsertedRows } = makeClient({ upsert: { error: null } });
    await setUserApiKey("u1", "azure_openai", { endpoint: "ep", deployment: "dep" }, client as never);
    expect(JSON.parse(decryptStored(upsertedRows[0]!))).toEqual({ endpoint: "ep", deployment: "dep", key: null, version: null });
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
      // Dev drift: the storage metadata vocabulary now includes cloud/search providers.
      brave: false, deepseek: false, tavily: false, bedrock: false, azure: false,
      "azure-foundry": false, vertex: false, xai: false, custom: false,
      claude: true,
      gemini: false,
      openai: false,
      kimi: false, // Dev drift: Dev keeps the Kimi provider slot
      mistral: false,
      openrouter: false,
      vercel: false,
      "opencode-go": false,
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
      // Dev drift: the storage metadata vocabulary now includes cloud/search providers.
      brave: false, deepseek: false, tavily: false, bedrock: false, azure: false,
      "azure-foundry": false, vertex: false, xai: false, custom: false,
      claude: true,
      gemini: false,
      openai: true,
      kimi: false, // Dev drift: Dev keeps the Kimi provider slot
      mistral: false,
      openrouter: false,
      vercel: false,
      "opencode-go": false,
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
      // Dev drift: the storage metadata vocabulary now includes cloud/search providers.
      brave: false, deepseek: false, tavily: false, bedrock: false, azure: false,
      "azure-foundry": false, vertex: false, xai: false, custom: false,
      claude: false,
      gemini: false,
      openai: false,
      kimi: false, // Dev drift: Dev keeps the Kimi provider slot
      mistral: false,
      openrouter: false,
      vercel: false,
      "opencode-go": false,
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
