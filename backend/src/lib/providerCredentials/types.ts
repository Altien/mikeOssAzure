import type { ProviderSettings } from "../llm";
import type { WebSearchBackend } from "../webSearch/settings";

// Upstream divergence (sync-log: 877f4598): upstream extracted these types
// from the per-user key store. Dev keeps its own provider set (kimi,
// tokenjuice, meta, azure_openai) and the pooled-tenancy status fields.
//
// `openrouter` and `courtlistener` added with upstream 44e868e
// (CourtListener integration). Unlike upstream, their org-level
// fallback goes through resolveSecret() (Key Vault primary, env var
// fallback — internal design notes §2.4) instead of raw process.env.
export type ApiKeyProvider =
    | "claude"
    | "gemini"
    | "openai"
    | "kimi"
    | "mistral"
    | "openrouter"
    | "opencode-go"
    | "vercel"
    | "courtlistener"
    | "bedrock"
    | "azure"
    | "azure-foundry"
    | "vertex"
    | "xai"
    | "custom"
    | "tokenjuice"
    | "meta"
    | "azure_openai"
    | WebSearchBackend;

export type ApiKeySource = "env" | "user" | "org" | null;

/** Whose credential a row or status belongs to. */
export type ApiKeyOwner = { kind: "user" | "org"; id: string };

/** Providers whose key is only usable together with a non-secret setting. */
export type SettingsApiKeyProvider = keyof ProviderSettings;

export type ApiKeyStatus = Record<ApiKeyProvider, boolean> & {
    sources: Record<ApiKeyProvider, ApiKeySource>;
    enabled: Partial<Record<ApiKeyProvider, boolean>>;
    settings: ProviderSettings;
    /** Tenant-level model allowlist (multi-tenant tenant settings); absent when unrestricted. */
    modelAllowlist?: readonly string[] | null;
    /** Pooled mode only: per model provider, who supplies the key. */
    pooledKeys?: Partial<Record<ApiKeyProvider, PooledKeyStatus>>;
};

export type PooledKeyStatus = {
    /** Models the member may run on their own key; empty when they may not set one. */
    memberKeyModels: string[];
    /** The member has saved their own key. */
    memberKeySet: boolean;
    /** The organisation (tenant) supplies its own key for this provider. */
    organisationKey: boolean;
};
