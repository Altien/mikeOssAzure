export type CatalogPricing = {
    input?: string;
    output?: string;
    variesByProvider?: true;
    tiered?: true;
};
export type CatalogModel = {
    id: string;
    label: string;
    pricing?: CatalogPricing;
};
// Dev (sync-log: 877f4598): no local Ollama model type (972cf22); the
// configured entry also carries administrator-entered providers' groups.
export type ConfiguredCatalogModel = {
    id: string;
    label: string;
    /** "Configured", or an administrator-entered provider's own name. */
    group: string;
    location: "cloud" | "local";
    source: "Configured";
    /** Managed model priced at zero on the tenant's price version. */
    free?: true;
};
export type CatalogFailure =
    | { ok: false; kind: "missing_api_key"; code: string; detail: string }
    | { ok: false; kind: "upstream"; error: Error }
    | { ok: false; kind: "error"; error: unknown };
export type CatalogResult =
    | { ok: true; models: CatalogModel[] }
    | CatalogFailure;
