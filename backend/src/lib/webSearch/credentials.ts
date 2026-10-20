/** Deployment search keys use the existing explicit Key Vault-first boundary. */
import { resolveProviderSecret } from "../envSecrets";
import type { WebSearchBackend } from "./settings";
import type { WebSearchAccount } from "./types";

const SEARCH_SECRET_NAMES = {
  brave: { canonical: "brave-search-api-key", override: "BRAVE_SEARCH_API_KEY_SECRET_NAME" },
  tavily: { canonical: "tavily-api-key", override: "TAVILY_API_KEY_SECRET_NAME" },
  deepseek: { canonical: "deepseek-search-api-key", override: "DEEPSEEK_SEARCH_API_KEY_SECRET_NAME" },
} as const;

export async function loadDeploymentSearchApiKeys(): Promise<Record<WebSearchBackend, string | null>> {
  const resolve = async (backend: WebSearchBackend): Promise<string | null> => {
    const { canonical, override } = SEARCH_SECRET_NAMES[backend];
    const custom = process.env[override]?.trim();
    const names = [...new Set([custom, canonical].filter((name): name is string => !!name))];
    // Every supported vault alias is checked before local environment fallback.
    const value = await resolveProviderSecret(names[0]!, names.slice(1));
    return value || null;
  };
  const [brave, tavily, deepseek] = await Promise.all([
    resolve("brave"), resolve("tavily"), resolve("deepseek"),
  ]);
  return { brave, tavily, deepseek };
}

export async function loadDeploymentSearchAccount(backend: WebSearchBackend): Promise<WebSearchAccount | null> {
  const keys = await loadDeploymentSearchApiKeys();
  const apiKey = keys[backend];
  return apiKey ? { backend, apiKey } : null;
}
