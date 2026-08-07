/// <reference types="office-js" />
/**
 * Configured @mike/api-client barrel for the Word add-in — the single place the
 * shared typed client is wired to the add-in's Office session. Mirrors
 * apps/web/src/app/lib/mikeApi.ts, but its auth comes from ../auth/session
 * (Entra via MSAL in this fork) instead of a browser SDK session.
 *
 * Components import API functions FROM THIS MODULE (not from "@mike/api-client"
 * directly) so that importing any of them runs the side-effecting
 * configureMikeApiClient() below before the first request leaves.
 */
import { configureMikeApiClient } from "@mike/api-client";
import type { Document } from "@mike/core";
import { getFreshAccessToken, refreshSession } from "../auth/session";
import { API_BASE_URL } from "../auth/runtimeConfig";

// Dev fork: every backend router is mounted under /api (upstream's are at the
// root), so the client's base is `${REACT_APP_API_BASE_URL}/api`.
const BASE_URL: string = API_BASE_URL;

async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await getFreshAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Reactive 401 recovery in ONE place (replaces the old client.ts replay): if a
// request is rejected, refresh the session once and replay with the new token.
const fetchWithRefresh: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (res.status !== 401) return res;
  const refreshed = await refreshSession();
  if (!refreshed) return res; // refresh failed → session cleared → surfaces 401
  const headers = new Headers(init?.headers as HeadersInit | undefined);
  headers.set("Authorization", `Bearer ${refreshed}`);
  return fetch(input, { ...init, headers });
};

configureMikeApiClient({
  baseUrl: BASE_URL,
  getAuthHeaders,
  fetchImpl: fetchWithRefresh,
});

export * from "@mike/api-client";

/**
 * List a project's documents (GET /projects/:id/documents). @mike/api-client
 * exposes no wrapper for this endpoint (the web app reads project.documents off
 * GET /projects/:id instead), so this thin helper reuses the SAME configured
 * auth + 401-refresh transport as the rest of the client rather than
 * re-declaring a bespoke HTTP layer — and keeps the add-in on the exact same
 * endpoint it has always called.
 */
export async function listProjectDocuments(
  projectId: string
): Promise<Document[]> {
  const res = await fetchWithRefresh(
    `${BASE_URL}/projects/${projectId}/documents`,
    {
      cache: "no-store",
      headers: { Accept: "application/json", ...(await getAuthHeaders()) },
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GET /projects/${projectId}/documents failed (${res.status}): ${body}`
    );
  }
  return res.json() as Promise<Document[]>;
}

export interface AzureModelOption {
  id: string;
  label: string;
  group: "Azure OpenAI";
}

/** Upstream divergence (sync-log: 148635e3): dev discovers Azure deployments instead of Ollama. */
export async function getAzureModels(): Promise<AzureModelOption[]> {
  const res = await fetchWithRefresh(`${BASE_URL}/llm/azure-openai/deployments`, {
    cache: "no-store",
    headers: { Accept: "application/json", ...(await getAuthHeaders()) },
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { deployments?: { name: string; model?: string | null }[] };
  return (body.deployments ?? []).map((d) => ({ id: `aoai:${d.name}`, label: d.model ? `${d.name} (${d.model})` : d.name, group: "Azure OpenAI" }));
}
