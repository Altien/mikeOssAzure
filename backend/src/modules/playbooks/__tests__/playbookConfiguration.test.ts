import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";

const { getUserApiKeys, getEffectiveApiKeys, filterTenantModels, routerModels, workspace } =
  vi.hoisted(() => ({
    getUserApiKeys: vi.fn(),
    getEffectiveApiKeys: vi.fn(),
    filterTenantModels: vi.fn(),
    routerModels: {
      current: {} as Record<string, string[]>,
    },
    workspace: { current: null as Record<string, unknown> | null },
  }));

vi.mock("../../../lib/providerCredentials/index", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/providerCredentials/index")>()),
  getUserApiKeys,
  getEffectiveApiKeys,
}));
vi.mock("../../../lib/routerModels", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../lib/routerModels")>();
  const selections = () =>
    ({
      ...Object.fromEntries(actual.ROUTER_SLUGS.map((slug) => [slug, []])),
      ...routerModels.current,
    }) as Awaited<ReturnType<typeof actual.getEffectiveRouterModels>>;
  return {
    ...actual,
    getEffectiveRouterModels: vi.fn(async () => selections()),
    // Dev also resolves each candidate (resolveRequestedModel reads the
    // router selections itself): judge router models against the same
    // mocked selections, everything else as the real resolver does.
    resolveRequestedModel: vi.fn(
      async (...args: Parameters<typeof actual.resolveRequestedModel>) => {
        const [model] = args;
        if (typeof model === "string" && actual.routerForModelId(model)) {
          if (!actual.isRouterModelSelected(model, selections()))
            throw new Error("Router model not selected");
          return model;
        }
        return actual.resolveRequestedModel(...args);
      },
    ),
  };
});
vi.mock("../../../lib/workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/workspace")>()),
  resolveWorkspaceFilter: vi.fn(async (_db: unknown, _user: string, raw: unknown) => ({
    ok: true,
    workspace: raw ?? null,
  })),
}));
vi.mock("../../../lib/orgPreferences", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/orgPreferences")>()),
  loadWorkspacePreferences: vi.fn(async () => workspace.current),
}));

vi.mock("../../../lib/tenantSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/tenantSettings")>()),
  filterTenantModels,
}));

import { playbookConfiguration } from "../playbooks.operations";

function dbWithProfile(profile: Record<string, string | null>): Db {
  return { from: vi.fn((table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order"]) query[method] = vi.fn(() => query);
    query.maybeSingle = vi.fn(async () => ({ data: table === "user_profiles" ? profile : null, error: null }));
    query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
    return query;
  }) } as unknown as Db;
}

describe("playbookConfiguration", () => {
  beforeEach(() => {
    filterTenantModels.mockReset().mockImplementation(async (models: readonly unknown[]) => [...models]);
    routerModels.current = {};
    workspace.current = null;
    getUserApiKeys.mockResolvedValue({
      claude: "sk-ant",
      gemini: "gm",
      openai: "sk-oa",
    });
  });

  it("defaults to the assistant's last selected chat model", async () => {
    const config = await playbookConfiguration(
      "u1",
      dbWithProfile({
        last_selected_chat_model: "gpt-6.1-sol",
        fast_model: "gemini-3.8-flash",
        tabular_model: "claude-sonnet-5-5",
      }),
    );

    expect(config.defaultModel).toBe("gpt-6.1-sol");
  });

  it("maps a legacy chat model id to its current equivalent", async () => {
    const config = await playbookConfiguration(
      "u1",
      dbWithProfile({ last_selected_chat_model: "claude-opus-4-7" }),
    );

    expect(config.defaultModel).toBe("claude-opus-5-5");
  });

  it("falls back to a background-task model when the chat model is unavailable", async () => {
    getUserApiKeys.mockResolvedValue({ gemini: "gm" });

    const config = await playbookConfiguration(
      "u1",
      dbWithProfile({
        last_selected_chat_model: "gpt-6.1-sol",
        fast_model: "gemini-3.8-flash",
      }),
    );

    expect(config.defaultModel).toBe("gemini-3.8-flash");
  });

  describe("administrator-entered providers", () => {
    beforeEach(() => {
      vi.stubEnv("KEY_VAULT_NAME", "");
      vi.stubEnv("TOKENJUICE_API_KEY", "org-key");
      vi.stubEnv("TOKENJUICE_BASE_URL", "https://tj.example.test/v1");
      vi.stubEnv("TOKENJUICE_MODELS", "juice-large");
      vi.stubEnv("META_API_KEY", "");
      vi.stubEnv("META_MODELS", "");
    });
    afterEach(() => vi.unstubAllEnvs());

    it("offers a configured model alongside the others", async () => {
      const config = await playbookConfiguration("u1", dbWithProfile({}));

      expect(config.availableModelIds).toContain("tokenjuice/juice-large");
      expect(config.availableModelIds).toContain("claude-sonnet-5-5");
    });

    it("offers and defaults to it on an install with only that provider", async () => {
      getUserApiKeys.mockResolvedValue({});

      const config = await playbookConfiguration("u1", dbWithProfile({}));

      expect(config.availableModelIds).toEqual(["tokenjuice/juice-large"]);
      expect(config.defaultModel).toBe("tokenjuice/juice-large");
    });

    it("leaves it out when its settings are incomplete", async () => {
      vi.stubEnv("TOKENJUICE_MODELS", "");

      const config = await playbookConfiguration("u1", dbWithProfile({}));

      expect(config.availableModelIds).not.toContain("tokenjuice/juice-large");
    });

    it("leaves it out for a tenant whose allowlist does not name it", async () => {
      filterTenantModels.mockImplementation(async () => []);

      const config = await playbookConfiguration("u1", dbWithProfile({}));

      expect(config.availableModelIds).not.toContain("tokenjuice/juice-large");
    });
  });

  it("takes the background-task models from the organization in its workspace", async () => {
    getEffectiveApiKeys.mockResolvedValue({ gemini: "gm", claude: "sk-ant" });
    workspace.current = { title_model: "gemini-3.8-flash", tabular_model: null };

    // Dev stores the person's title override in fast_model.
    const config = await playbookConfiguration(
      "u1",
      dbWithProfile({ fast_model: "claude-sonnet-5-5" }),
      "org-1",
    );

    expect(config.defaultModel).toBe("gemini-3.8-flash");
  });

  it("skips a router model that is no longer selected for its router", async () => {
    getUserApiKeys.mockResolvedValue({ gemini: "gm", openrouter: "or" });
    const profile = {
      last_selected_chat_model: "openrouter/acme/model-x",
      fast_model: "gemini-3.8-flash",
    };

    const deselected = await playbookConfiguration("u1", dbWithProfile(profile));
    expect(deselected.defaultModel).toBe("gemini-3.8-flash");
    expect(deselected.availableModelIds).not.toContain("openrouter/acme/model-x");

    routerModels.current = { openrouter: ["acme/model-x"] };
    const selected = await playbookConfiguration("u1", dbWithProfile(profile));
    expect(selected.defaultModel).toBe("openrouter/acme/model-x");
  });
});
