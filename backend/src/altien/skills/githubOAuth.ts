import { createHash, randomBytes } from "node:crypto";
import type { Request } from "express";
import { createServerSupabase } from "../../lib/supabase";
import { decryptString, encryptString } from "../../lib/mcp/client";
import { resolveSecret } from "../../lib/envSecrets";
import { throwOnDbError, type Db } from "./shared";
const STATE_TTL_MS = 10 * 60 * 1_000;

async function loadGitHubOAuthConfig() {
  const [clientId, clientSecret] = await Promise.all([
    resolveSecret("github-skill-oauth-client-id"),
    resolveSecret("github-skill-oauth-client-secret"),
  ]);
  if (!clientId || !clientSecret) {
    throw new Error("GitHub skill OAuth is not configured for this deployment.");
  }
  return { clientId, clientSecret };
}

export async function githubSkillOAuthConfigured() {
  try {
    await loadGitHubOAuthConfig();
    return true;
  } catch {
    return false;
  }
}

export function githubSkillOAuthCallbackUrl(req: Pick<Request, "protocol" | "get">) {
  const base = (
    process.env.API_PUBLIC_URL ||
    process.env.BACKEND_URL ||
    `${req.protocol}://${req.get("host")}`
  ).replace(/\/+$/, "");
  return `${base}/api/altien/skills/settings/github/oauth/callback`;
}

function stateHash(state: string) {
  return createHash("sha256").update(state).digest("hex");
}

export async function startGitHubSkillOAuth(args: {
  tenantId: string;
  userId: string;
  redirectUri: string;
  db?: Db;
}) {
  const db = args.db ?? createServerSupabase();
  const { clientId } = await loadGitHubOAuthConfig();
  const state = randomBytes(32).toString("base64url");
  const inserted = await db.from("altien_skill_github_oauth_states").insert({
    tenant_id: args.tenantId,
    created_by: args.userId,
    state_hash: stateHash(state),
    redirect_uri: args.redirectUri,
    expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
  });
  throwOnDbError(inserted);
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  // GitHub OAuth has no read-only repository scope: `repo` is the narrowest
  // scope that can read a private repository, and it carries write access.
  // The spec's private-App access (a GitHub App with Contents: read-only) is
  // the follow-on path for true least-privilege private reads; the callers
  // here only ever issue bounded read operations against the REST API.
  url.searchParams.set("scope", "repo");
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "false");
  return { authorizationUrl: url.toString() };
}

async function githubRequest<T>(
  url: string,
  init: RequestInit,
  fetcher: typeof fetch,
) {
  const response = await fetcher(url, {
    ...init,
    redirect: "error",
    headers: {
      Accept: "application/json",
      "User-Agent": "Mike-Skills",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub OAuth request failed with status ${response.status}.`);
  }
  return {
    data: (await response.json()) as T,
    headers: response.headers,
  };
}

export async function completeGitHubSkillOAuth(args: {
  state: string;
  code: string;
  db?: Db;
  fetcher?: typeof fetch;
}) {
  const db = args.db ?? createServerSupabase();
  const fetcher = args.fetcher ?? fetch;
  const oauthConfig = await loadGitHubOAuthConfig();
  const state = await db
    .from("altien_skill_github_oauth_states")
    .select("*")
    .eq("state_hash", stateHash(args.state))
    .maybeSingle();
  throwOnDbError(state);
  if (
    !state.data ||
    new Date(String(state.data.expires_at)).getTime() <= Date.now()
  ) {
    throw new Error("GitHub OAuth state is invalid or expired.");
  }
  const token = await githubRequest<{
    access_token?: string;
    error?: string;
    error_description?: string;
    scope?: string;
  }>(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: oauthConfig.clientId,
        client_secret: oauthConfig.clientSecret,
        code: args.code,
        redirect_uri: String(state.data.redirect_uri),
        state: args.state,
      }),
    },
    fetcher,
  );
  if (!token.data.access_token || token.data.error) {
    throw new Error(
      token.data.error_description ??
        token.data.error ??
        "GitHub OAuth did not return an access token.",
    );
  }
  const profile = await githubRequest<{ id: number; login: string }>(
    "https://api.github.com/user",
    {
      headers: {
        Authorization: `Bearer ${token.data.access_token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
    fetcher,
  );
  const encrypted = await encryptString(token.data.access_token);
  const scopes = (
    profile.headers.get("x-oauth-scopes") ??
    token.data.scope ??
    ""
  )
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  const existing = await db
    .from("altien_skill_github_connections")
    .select("tenant_id")
    .eq("tenant_id", state.data.tenant_id)
    .maybeSingle();
  throwOnDbError(existing);
  const payload = {
    encrypted_access_token: encrypted.encrypted,
    access_token_iv: encrypted.iv,
    access_token_tag: encrypted.tag,
    github_user_id: String(profile.data.id),
    github_login: profile.data.login,
    granted_scopes: scopes,
    connected_by: state.data.created_by,
    connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const write = existing.data
    ? await db
        .from("altien_skill_github_connections")
        .update(payload)
        .eq("tenant_id", state.data.tenant_id)
    : await db.from("altien_skill_github_connections").insert({
        tenant_id: state.data.tenant_id,
        ...payload,
      });
  throwOnDbError(write);
  await db
    .from("altien_skill_github_oauth_states")
    .delete()
    .eq("id", state.data.id);
  return {
    tenantId: String(state.data.tenant_id),
    githubLogin: profile.data.login,
    grantedScopes: scopes,
  };
}

export async function getGitHubSkillOAuthConnection(
  tenantId: string,
  db: Db = createServerSupabase(),
) {
  const result = await db
    .from("altien_skill_github_connections")
    .select(
      "tenant_id, github_login, github_user_id, granted_scopes, connected_at",
    )
    .eq("tenant_id", tenantId)
    .maybeSingle();
  throwOnDbError(result);
  return result.data
    ? {
        connected: true,
        githubLogin: String(result.data.github_login ?? ""),
        grantedScopes: Array.isArray(result.data.granted_scopes)
          ? result.data.granted_scopes.map(String)
          : [],
        connectedAt: String(result.data.connected_at),
      }
    : { connected: false, githubLogin: null, grantedScopes: [], connectedAt: null };
}

export async function getGitHubSkillOAuthToken(
  tenantId: string,
  db: Db = createServerSupabase(),
) {
  const result = await db
    .from("altien_skill_github_connections")
    .select("encrypted_access_token, access_token_iv, access_token_tag")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  throwOnDbError(result);
  if (!result.data) return null;
  return decryptString(
    result.data.encrypted_access_token,
    result.data.access_token_iv,
    result.data.access_token_tag,
  );
}

export async function disconnectGitHubSkillOAuth(
  tenantId: string,
  db: Db = createServerSupabase(),
) {
  const deleted = await db
    .from("altien_skill_github_connections")
    .delete()
    .eq("tenant_id", tenantId);
  throwOnDbError(deleted);
}
