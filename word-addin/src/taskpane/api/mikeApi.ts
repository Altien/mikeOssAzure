/// <reference types="office-js" />
/**
 * Configured @mike/api-client barrel for the Word add-in — the single place the
 * shared typed client is wired to the add-in's Office session. Mirrors
 * apps/web/src/app/lib/mikeApi.ts, but its auth comes from ../auth/session
 * (Entra via MSAL in this fork) instead of a browser SDK session.
 *
 * Components import API functions FROM THIS MODULE (not from the base client
 * directly) so that importing any of them runs the side-effecting
 * configureMikeApiClient() below before the first request leaves.
 */
import { configureMikeApiClient } from "./client";
import type { Chat, Document, Message } from "../types";
import { getFreshAccessToken, refreshSession } from "../auth/session";
import { API_BASE_URL } from "../auth/runtimeConfig";
import {
  assistantContentFromEvents,
  documentReadsFromAssistantEvents,
  normalizeStoredAssistantEvents,
} from "../lib/wordChatEvents";

// Dev fork: every backend router is mounted under /api (upstream's are at the
// root), so the client's base is `${REACT_APP_API_BASE_URL}/api`.
const BASE_URL: string = API_BASE_URL;

async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await getFreshAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Centralized reactive 401 recovery: refresh the session once, then replay the
// rejected request with the new token.
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

export {
  createWorkflow,
  getApiKeyStatus,
  getLibrary,
  getUserProfile,
  listProjects,
  listWorkflows,
  readSSE,
  streamWordChat,
  updateWorkflow,
  uploadStandaloneDocument,
} from "./client";
export type { ApiKeyStatus } from "./client";

/**
 * List a project's documents (GET /projects/:id/documents). The base client
 * exposes no wrapper for this endpoint (the web app reads project.documents off
 * GET /projects/:id instead), so this thin helper reuses the SAME configured
 * auth + 401-refresh transport as the rest of the client rather than
 * re-declaring a bespoke HTTP layer — and keeps the add-in on the exact same
 * endpoint it has always called.
 */
export async function listProjectDocuments(
  projectId: string,
): Promise<Document[]> {
  const res = await fetchWithRefresh(
    `${BASE_URL}/projects/${projectId}/documents`,
    {
      cache: "no-store",
      headers: { Accept: "application/json", ...(await getAuthHeaders()) },
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GET /projects/${projectId}/documents failed (${res.status}): ${body}`,
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

interface WordChatServerMessage {
  id: string;
  role: "user" | "assistant";
  content: string | unknown[] | null;
  files?: { filename: string; document_id?: string }[] | null;
  workflow?: { id: string; title: string } | null;
}

async function throwWordChatResponseError(
  response: Response,
  fallback: string,
): Promise<never> {
  const body = await response.text().catch(() => "");
  throw new Error(body || `${fallback} (${response.status}).`);
}

export async function listCloudWordChats(
  documentId: string,
  limit: number,
  offset = 0,
  signal?: AbortSignal,
): Promise<Chat[]> {
  const params = new URLSearchParams({
    document_id: documentId,
    limit: String(limit),
    offset: String(offset),
  });
  const res = await fetchWithRefresh(`${BASE_URL}/word-chat?${params}`, {
    cache: "no-store",
    signal,
    headers: { Accept: "application/json", ...(await getAuthHeaders()) },
  });
  if (!res.ok) {
    await throwWordChatResponseError(res, "Failed to load Word chats");
  }
  return res.json() as Promise<Chat[]>;
}

export async function getCloudWordChat(
  documentId: string,
  chatId: string,
): Promise<{ chat: Chat; messages: Message[] }> {
  const params = new URLSearchParams({ document_id: documentId });
  const res = await fetchWithRefresh(
    `${BASE_URL}/word-chat/${encodeURIComponent(chatId)}?${params}`,
    {
      cache: "no-store",
      headers: { Accept: "application/json", ...(await getAuthHeaders()) },
    },
  );
  if (!res.ok) {
    await throwWordChatResponseError(res, "Failed to open Word chat");
  }
  const raw = (await res.json()) as {
    chat: Chat;
    messages: WordChatServerMessage[];
  };
  return {
    chat: raw.chat,
    messages: raw.messages.map((message): Message => {
      if (message.role === "user") {
        return {
          id: message.id,
          role: "user",
          content: typeof message.content === "string" ? message.content : "",
          files: message.files ?? undefined,
          workflow: message.workflow ?? undefined,
        };
      }
      const hasEventContent = Array.isArray(message.content);
      const events = normalizeStoredAssistantEvents(message.content);
      const content = hasEventContent
        ? assistantContentFromEvents(events)
        : typeof message.content === "string"
          ? message.content
          : "";
      const docReads = documentReadsFromAssistantEvents(events);
      return {
        id: message.id,
        role: "assistant",
        content,
        docReads: docReads.length > 0 ? docReads : undefined,
        events: hasEventContent ? events : undefined,
      };
    }),
  };
}
