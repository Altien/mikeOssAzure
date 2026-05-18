// Lists the deployments configured on a customer's Azure OpenAI
// resource. Used by the model picker so users can choose any of their
// own deployments rather than being limited to a single hardcoded one.
//
// AOAI exposes this directly:
//
//   GET <endpoint>/openai/deployments?api-version=<ver>
//   api-key: <key>
//
//   {
//     "data": [
//       { "id": "<deployment-name>", "model": "<base-model>", "object": "deployment", ... }
//     ]
//   }
//
// We only forward the bits the picker needs (deployment name + base
// model) and surface failures as a structured error rather than letting
// them bubble up unfiltered to the client.

import type { AzureOpenaiSettings } from "./types";
import { resolveSecret } from "../envSecrets";

// Pinned for the LISTING call only. Newer api-versions (2024-10-21,
// 2024-08-01-preview) return 404 against the /openai/deployments route
// on Foundry / multi-service Azure resources — this older version is
// the one the data-plane listing endpoint accepts everywhere we've
// tested. Inference calls (chat/completions, embeddings, etc.) are
// unaffected; the user's azure_openai_api_version still controls those
// via the streamAzureOpenAI adapter.
const LIST_DEPLOYMENTS_API_VERSION = "2023-03-15-preview";

export type AzureOpenaiDeployment = {
    name: string;
    model: string | null;
};

export type ListDeploymentsResult =
    | {
          ok: true;
          source: "personal" | "global";
          deployments: AzureOpenaiDeployment[];
      }
    | { ok: false; reason: "not_configured" }
    | { ok: false; reason: "fetch_failed"; status: number; detail: string };

type RawDeployment = {
    id?: string;
    model?: string;
};

type RawListResponse = {
    data?: RawDeployment[];
};

async function pickSettingsSource(
    personal?: AzureOpenaiSettings | null,
): Promise<{
    source: "personal" | "global";
    endpoint: string;
    apiKey: string;
} | null> {
    // Prefer the user's own AOAI when both endpoint + key are filled in.
    // Otherwise fall back to the global pair via resolveSecret() — which
    // covers BOTH the env (Bicep secretRef) and the KV-direct paths the
    // install configurator writes. Closes 040 Entry 12 for the
    // deployment-discovery code path. We don't merge personal + global —
    // listing deployments from two different resources in the same
    // picker would be confusing.
    if (personal?.endpoint?.trim() && personal?.apiKey?.trim()) {
        return {
            source: "personal",
            endpoint: personal.endpoint.trim(),
            apiKey: personal.apiKey.trim(),
        };
    }
    const endpoint = await resolveSecret("azure-openai-endpoint");
    const apiKey = await resolveSecret("azure-openai-api-key");
    if (endpoint && apiKey) {
        return {
            source: "global",
            endpoint,
            apiKey,
        };
    }
    return null;
}

export async function listAzureOpenaiDeployments(
    personal?: AzureOpenaiSettings | null,
): Promise<ListDeploymentsResult> {
    const picked = await pickSettingsSource(personal);
    if (!picked) return { ok: false, reason: "not_configured" };

    // AOAI is happy with or without a trailing slash; normalize so the
    // joined URL doesn't end up with `//openai/...`.
    const base = picked.endpoint.replace(/\/+$/, "");
    const url = `${base}/openai/deployments?api-version=${LIST_DEPLOYMENTS_API_VERSION}`;

    try {
        const resp = await fetch(url, {
            method: "GET",
            headers: { "api-key": picked.apiKey },
        });
        if (!resp.ok) {
            const detail = await resp.text().catch(() => "");
            console.error("[aoai-deployments] fetch failed", {
                status: resp.status,
                detail,
                source: picked.source,
            });
            return {
                ok: false,
                reason: "fetch_failed",
                status: resp.status,
                detail: detail.slice(0, 500),
            };
        }
        const json = (await resp.json()) as RawListResponse;
        const deployments: AzureOpenaiDeployment[] = (json.data ?? [])
            .filter((d): d is RawDeployment & { id: string } =>
                typeof d?.id === "string" && d.id.length > 0,
            )
            .map((d) => ({
                name: d.id,
                model: typeof d.model === "string" ? d.model : null,
            }));
        return { ok: true, source: picked.source, deployments };
    } catch (err) {
        console.error("[aoai-deployments] fetch threw", err);
        return {
            ok: false,
            reason: "fetch_failed",
            status: 0,
            detail: err instanceof Error ? err.message : String(err),
        };
    }
}
