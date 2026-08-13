import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cachedAdminClient:
  | {
      url: string;
      key: string;
      provider: string;
      client: SupabaseClient<any, "public", any>;
    }
  | undefined;

// Historical naming note:
// the upstream app used hosted Supabase directly. In this fork the backend still
// uses supabase-js as a PostgREST query client, but SUPABASE_URL may point to
// PostgREST directly (local dev or Azure deployment) rather than hosted Supabase.
// Treat this module as the current data-client boundary, not as a platform
// decision to keep Supabase services.

function getAuthProvider() {
  return (process.env.AUTH_PROVIDER ?? "supabase").toLowerCase();
}

// supabase-js hard-codes `${url}/rest/v1` as the REST base — that prefix
// matches hosted Supabase but PostgREST serves tables at root.  This
// wrapper rewrites the path back to root.  Used in both local and entra
// modes so the unmodified supabase-js client can talk to PostgREST
// directly (no Caddy or other reverse proxy required).
//
// In entra mode we additionally strip the Authorization and apikey
// headers — the deployed PostgREST has no JWT validation configured
// (PGRST_DB_ANON_ROLE = service_role) and refuses requests carrying
// Authorization when no jwt-secret is set.  Trust comes from network
// isolation: nothing outside the Container Apps Environment can reach
// PostgREST.  In local mode the headers are kept because PostgREST
// validates the JWT against PGRST_JWT_SECRET.
//
// Built around `new Request(input, init)` so it handles both call shapes
// supabase-js uses internally (string URL + init, or Request as input).
function postgrestFetchWrapper(opts: { stripAuth: boolean }): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.startsWith("/rest/v1/")) {
      url.pathname = url.pathname.slice("/rest/v1".length);
    }
    if (opts.stripAuth) {
      request.headers.delete("Authorization");
      request.headers.delete("apikey");
    }
    return fetch(url.toString(), {
      method: request.method,
      headers: request.headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer(),
      redirect: request.redirect,
      signal: request.signal,
    });
  };
}

/**
 * Server-side PostgREST client implemented with supabase-js.
 * - supabase mode: service-role JWT via SUPABASE_SECRET_KEY; default
 *   supabase-js fetch (sends to /rest/v1/<table>, which is what hosted
 *   Supabase serves).
 * - local mode: service-role JWT via SUPABASE_SECRET_KEY; URL-rewrite
 *   wrapper so SUPABASE_URL can point at PostgREST directly (no proxy).
 * - entra mode: no JWT.  Headers stripped; PostgREST treats every request
 *   as anonymous and uses its anon-role default (service_role).  See the
 *   long comment in infra/modules/containerapp-postgrest.bicep for the
 *   full trust-model rationale.
 */
export function createServerSupabase() {
  const url = process.env.SUPABASE_URL || "";
  if (!url) {
    throw new Error("SUPABASE_URL is required");
  }

  const provider = getAuthProvider();
  const key = provider === "entra"
    ? "unused-entra-mode-no-auth"
    : process.env.SUPABASE_SECRET_KEY || "";

  if (provider === "supabase" && !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set");
  }

  if (
    cachedAdminClient?.url === url &&
    cachedAdminClient.key === key &&
    cachedAdminClient.provider === provider
  ) {
    return cachedAdminClient.client;
  }

  let client: SupabaseClient<any, "public", any>;

  if (provider === "entra") {
    // The "key" arg is required by supabase-js but never reaches PostgREST
    // — the fetch wrapper deletes the Authorization and apikey headers
    // before the request leaves the process.
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: postgrestFetchWrapper({ stripAuth: true }) },
    });
  } else if (provider === "local") {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: postgrestFetchWrapper({ stripAuth: false }) },
    });
  } else {
    // Hosted Supabase keeps its /rest/v1 path and service-role credential.
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  cachedAdminClient = { url, key, provider, client };
  return client;
}
