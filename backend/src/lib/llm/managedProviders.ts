import { resolveProviderSecret } from "../envSecrets";
import { isSafeAccountModelId } from "./models";
import { validBaseUrl } from "./registry";

// Dev divergence: OpenAI-compatible providers whose address and model names an
// administrator enters on /install, because they are not published. Their ids
// are `<provider>/<model name>`. They are not routers: nobody saves a per-user
// model selection, and the administrator's list is what may run. Pickers learn
// them from GET /models/configured.

export type ManagedProvider = "tokenjuice" | "meta";

type ManagedProviderDefinition = {
    label: string;
    keySecret: string;
    baseUrlSecret: string;
    modelsSecret: string;
    defaultBaseUrl?: string;
};

export const MANAGED_PROVIDERS: Record<ManagedProvider, ManagedProviderDefinition> = {
    tokenjuice: {
        label: "TokenJuice",
        keySecret: "tokenjuice-api-key",
        baseUrlSecret: "tokenjuice-base-url",
        modelsSecret: "tokenjuice-models",
    },
    meta: {
        label: "Meta (Muse)",
        keySecret: "meta-api-key",
        baseUrlSecret: "meta-base-url",
        modelsSecret: "meta-models",
        // UNVERIFIED: taken second-hand from LiteLLM's documentation, not from
        // Meta. Administrators can override it with meta-base-url.
        defaultBaseUrl: "https://api.meta.ai/v1",
    },
};

export const MANAGED_PROVIDER_IDS = Object.keys(MANAGED_PROVIDERS) as ManagedProvider[];

export function isManagedProvider(value: string): value is ManagedProvider {
    return Object.hasOwn(MANAGED_PROVIDERS, value);
}

// The browser check on /install. Both patterns keep to syntax that also compiles
// under the `v` flag browsers use for the HTML pattern attribute.
export const MANAGED_BASE_URL_PATTERN = "^https?:\\/\\/[^\\s\\/?#@]+(\\/[^\\s?#]*)?$";
export const MANAGED_MODELS_PATTERN =
    "^[A-Za-z0-9._:@+\\/\\-]+(\\s*,\\s*[A-Za-z0-9._:@+\\/\\-]+)*$";

function modelTokens(raw: string): string[] {
    return raw.split(/[\s,]+/).filter(Boolean);
}

/** The administrator's comma-separated list; a name unsafe in a URL never runs. */
export function parseManagedModels(raw: string): string[] {
    return [...new Set(modelTokens(raw).filter((name) => isSafeAccountModelId("custom", name)))];
}

export function isValidManagedModelList(raw: string): boolean {
    const tokens = modelTokens(raw);
    return tokens.length > 0 && tokens.every((name) => isSafeAccountModelId("custom", name));
}

export type ManagedProviderConfig = { apiKey: string; baseUrl: string; models: string[] };
type Unavailable = { ok: false; detail: string };
export type ManagedProviderResolution = ({ ok: true } & ManagedProviderConfig) | Unavailable;

function notConfigured(provider: ManagedProvider, secretName: string): Unavailable {
    const { label } = MANAGED_PROVIDERS[provider];
    return {
        ok: false,
        detail: `${label} is not configured for this organisation. Ask an administrator to open /install and set the ${secretName} Key Vault secret.`,
    };
}

/**
 * Resolve one provider's organisation settings: complete, or the administrator
 * action that would complete it. The key is read first because an unset secret
 * is a live vault request, so an unused provider costs only one.
 */
export async function resolveManagedProvider(provider: ManagedProvider): Promise<ManagedProviderResolution> {
    const { keySecret, baseUrlSecret, modelsSecret, defaultBaseUrl, label } = MANAGED_PROVIDERS[provider];
    const apiKey = await resolveProviderSecret(keySecret);
    if (!apiKey) return notConfigured(provider, keySecret);

    // Only a confirmed absence may select the default: the organisation key and
    // prompts must not go elsewhere because a replaced address could not be read.
    let configuredBaseUrl: string;
    try {
        configuredBaseUrl = await resolveProviderSecret(baseUrlSecret, [], { failOnUnreadable: true });
    } catch {
        return {
            ok: false,
            detail: `${label}'s base URL could not be read. Try again shortly, or ask an administrator to check access to the ${baseUrlSecret} Key Vault secret.`,
        };
    }
    const baseUrl = configuredBaseUrl || defaultBaseUrl;
    if (!baseUrl) return notConfigured(provider, baseUrlSecret);
    if (!validBaseUrl(baseUrl)) {
        return {
            ok: false,
            detail: `${label} has an invalid base URL. Ask an administrator to open /install and correct the ${baseUrlSecret} Key Vault secret.`,
        };
    }

    const models = parseManagedModels(await resolveProviderSecret(modelsSecret));
    if (models.length === 0) return notConfigured(provider, modelsSecret);
    return { ok: true, apiKey, baseUrl: baseUrl.replace(/\/+$/, ""), models };
}

/** A model id's provider, when it is one of these. */
export function managedProviderForModel(model: string): ManagedProvider | null {
    return MANAGED_PROVIDER_IDS.find((provider) => model.startsWith(`${provider}/`)) ?? null;
}

export type ManagedModelResolution =
    | { ok: true; provider: ManagedProvider; apiKey: string; baseUrl: string; upstreamModel: string }
    | Unavailable;

/** Whether this exact id may run: only names on the administrator's list may. */
export async function resolveManagedModel(model: string): Promise<ManagedModelResolution> {
    const provider = managedProviderForModel(model);
    if (!provider) return { ok: false, detail: `${model} is not a managed provider model.` };
    const resolved = await resolveManagedProvider(provider);
    if (!resolved.ok) return resolved;
    const upstreamModel = model.slice(provider.length + 1);
    if (!resolved.models.includes(upstreamModel)) {
        const { label, modelsSecret } = MANAGED_PROVIDERS[provider];
        return {
            ok: false,
            detail: `${label} model ${upstreamModel} is not available in this organisation. Ask an administrator to open /install and add it to the ${modelsSecret} Key Vault secret, or select another model.`,
        };
    }
    return { ok: true, provider, apiKey: resolved.apiKey, baseUrl: resolved.baseUrl, upstreamModel };
}

export type ManagedCatalogModel = { id: string; label: string; group: string };

/** Secret-free picker rows; a provider appears once key, URL and models are all set. */
export async function managedProviderCatalog(): Promise<ManagedCatalogModel[]> {
    const resolved = await Promise.all(MANAGED_PROVIDER_IDS.map(resolveManagedProvider));
    return MANAGED_PROVIDER_IDS.flatMap((provider, index) => {
        const config = resolved[index];
        if (!config?.ok) return [];
        return config.models.map((name) => ({
            id: `${provider}/${name}`,
            label: name,
            group: MANAGED_PROVIDERS[provider].label,
        }));
    });
}
