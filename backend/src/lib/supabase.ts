import { createHmac } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getConfig } from "./config";
import { getTenancyMode } from "./tenancyMode";
import { currentTenant, installTenantId, recordNoTenantContext, type TenantContext } from "./tenantContext";

/**
 * The server-side database handle every service function takes as its first
 * argument. One name for the whole backend: services and job handlers accept
 * a `Db`, route handlers obtain one from `createServerSupabase()` and pass it
 * down. Declaring the alias here (instead of a private
 * `type Db = ReturnType<typeof createServerSupabase>` in every file) keeps
 * the seam explicit and lets tests substitute a fake with a single cast.
 */
export type Db = SupabaseClient<any, "public", any>;

const cachedAdminClients = new Map<
  "request" | "platform",
  {
    url: string;
    key: string;
    provider: string;
    client: SupabaseClient<any, "public", any>;
  }
>();

// Historical naming note:
// the upstream app used hosted Supabase directly. In this fork the backend still
// uses supabase-js as a PostgREST query client, but SUPABASE_URL may point to
// PostgREST directly (local dev or Azure deployment) rather than hosted Supabase.
// Treat this module as the current data-client boundary, not as a platform
// decision to keep Supabase services.

function getAuthProvider() {
  return (process.env.AUTH_PROVIDER ?? "supabase").toLowerCase();
}

/**
 * Whether these clients sign per-request PostgREST JWTs (entra, local). Hosted
 * Supabase sends its static service-role key instead, so the database role of
 * tenant traffic there does not come from tenantDbRole().
 */
export function usesSignedPostgrest(): boolean {
  const provider = getAuthProvider();
  return provider === "entra" || provider === "local";
}

// ── Per-request PostgREST JWT (multi-tenant issues 002 and 008) ─────────────
// The one cached client stays; what changes is the fetch wrapper below. For
// every request it mints a short-lived HS256 token carrying the current
// tenant (lib/tenantContext.ts), so Postgres sees `request.jwt.claims`
// ->> 'tenant_id' / 'sub' and the tenant_isolation policies filter on it:
//
//   { role: "tenant_app", tenant_id, sub, iat, exp: iat + 60 }
//
// tenant_app (migration 0180) cannot bypass RLS. A call made without a tenant
// context is counted (db.no_tenant_context) and runs as the install's tenant
// (installTenantId), so single-tenant installs see what they saw before; a
// pooled install has none, and the call carries no claim and sees no rows.
// The platform client (createPlatformSupabase) sends role service_role
// without tenant_id or sub. Config
// `tenant-rls-enforced=false` (env TENANT_RLS_ENFORCED) sends service_role on
// the request client too: the rollback switch, no schema change needed.
//
// There is no unsigned fallback: with no signing secret the call fails before
// it is sent, and a token PostgREST rejects is returned as the error.

/** The claim PostgREST exposes as `request.jwt.claims ->> 'tenant_id'`. */
export const POSTGREST_TENANT_CLAIM = "tenant_id";
/** Database role for tenant traffic (RLS applies). */
export const TENANT_DB_ROLE = "tenant_app";
/** Database role for platform work (bypasses RLS). */
export const PLATFORM_DB_ROLE = "service_role";
const POSTGREST_JWT_TTL_SECONDS = 60;
const SECRET_TTL_MS = 5 * 60 * 1000;
const SECRET_MISS_TTL_MS = 60 * 1000;

let signingSecret: { provider: string; value: string | null; at: number } | undefined;
let rlsEnforced: { value: Promise<boolean>; at: number } | undefined;

/** Test seam: forget the cached signing secret and enforcement setting. */
export function resetPostgrestJwtState(): void {
  signingSecret = undefined;
  rlsEnforced = undefined;
}

/**
 * The role tenant traffic runs as: tenant_app, unless `tenant-rls-enforced`
 * is "false". Also used by StreamRunCluster for its raw SQL.
 */
export async function tenantDbRole(): Promise<string> {
  const now = Date.now();
  if (!rlsEnforced || now - rlsEnforced.at >= SECRET_TTL_MS) {
    // The pending lookup is cached too, so concurrent calls share one read;
    // anything but an explicit "false" (including a failed read) enforces.
    rlsEnforced = {
      value: getConfig("tenant-rls-enforced").then(
        (raw) => raw.trim().toLowerCase() !== "false",
        () => true,
      ),
      at: now,
    };
  }
  const enforced = await rlsEnforced.value;
  // A post-startup secret edit must never give pooled tenant requests BYPASSRLS.
  if (!enforced && await getTenancyMode() === "pooled") throw new Error("Pooled runtime requires enforced tenant RLS");
  return enforced ? TENANT_DB_ROLE : PLATFORM_DB_ROLE;
}

// Local mode signs with JWT_SECRET (the same value docker-compose passes
// PostgREST as PGRST_JWT_SECRET); entra reads Key Vault `postgrest-jwt-secret`
// (env POSTGREST_JWT_SECRET overrides, as for every getConfig key). PostgREST
// refuses secrets shorter than 32 characters, so such a value is unusable.
async function postgrestSigningSecret(provider: string): Promise<string | null> {
  const now = Date.now();
  if (signingSecret?.provider === provider) {
    const ttl = signingSecret.value ? SECRET_TTL_MS : SECRET_MISS_TTL_MS;
    if (now - signingSecret.at < ttl) return signingSecret.value;
  }
  let value = provider === "local" ? (process.env.JWT_SECRET ?? "").trim() : "";
  if (!value) value = (await getConfig("postgrest-jwt-secret").catch(() => "")).trim();
  signingSecret = { provider, value: value.length >= 32 ? value : null, at: now };
  return signingSecret.value;
}

/** HS256 JWT with node:crypto — PostgREST's `PGRST_JWT_SECRET` verifies it. */
export function signPostgrestJwt(claims: Record<string, unknown>, secret: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

/** The claims a request carries; also used by StreamRunCluster's raw SQL (003). */
export function postgrestClaims(
  tenant: TenantContext | undefined,
  role: string = PLATFORM_DB_ROLE,
): Record<string, unknown> {
  const iat = Math.floor(Date.now() / 1000);
  return {
    role,
    ...(tenant ? { [POSTGREST_TENANT_CLAIM]: tenant.tenantId } : {}),
    ...(tenant?.userId ? { sub: tenant.userId } : {}),
    ...(tenant?.pooled && tenant.roles ? { app_roles: tenant.roles } : {}),
    iat,
    exp: iat + POSTGREST_JWT_TTL_SECONDS,
  };
}

/**
 * Issue 004's gap hunt: `TENANT_CONTEXT_STRICT=true` makes a tenant-scoped
 * call without a tenant context fail instead of only being counted. A test /
 * local-stack switch; ignored when NODE_ENV=production.
 */
function tenantContextStrict(): boolean {
  return process.env.TENANT_CONTEXT_STRICT === "true" && process.env.NODE_ENV !== "production";
}

async function isJwtRejection(response: Response): Promise<boolean> {
  if (response.status !== 401 && response.status !== 500) return false;
  const body = await response.clone().json().catch(() => null) as { code?: unknown } | null;
  return typeof body?.code === "string" && /^PGRST30\d$/.test(body.code);
}

// supabase-js hard-codes `${url}/rest/v1` as the REST base — that prefix
// matches hosted Supabase but PostgREST serves tables at root.  This
// wrapper rewrites the path back to root.  Used in both local and entra
// modes so the unmodified supabase-js client can talk to PostgREST
// directly (no Caddy or other reverse proxy required).
//
// Authorization: see "Per-request PostgREST JWT" above. supabase-js's static
// key never leaves the process.
//
// Built around `new Request(input, init)` so it handles both call shapes
// supabase-js uses internally (string URL + init, or Request as input).
function failedResponse(code: string, message: string): Response {
  // A response, not a throw: postgrest-js retries thrown fetch errors on GET.
  // This becomes the call's `{ error }` without reaching PostgREST.
  return new Response(JSON.stringify({ code, message }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

let warnedNoSecret = false;

function postgrestFetchWrapper(opts: { provider: "entra" | "local"; platform: boolean }): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.startsWith("/rest/v1/")) {
      url.pathname = url.pathname.slice("/rest/v1".length);
    }
    let tenant = opts.platform ? undefined : currentTenant();
    if (!opts.platform && !tenant) {
      const target = `${request.method} ${url.pathname}`;
      recordNoTenantContext(target);
      if (tenantContextStrict()) {
        return failedResponse(
          "TENANT_CONTEXT_MISSING",
          `[tenant] database call without a tenant context: ${target}`,
        );
      }
      // A single-tenant install has one tenant, so the call runs as it, as
      // app.tenant_id_default() does for writes. Pooled installs have no
      // install tenant: the call carries no claim and sees no rows.
      const installTenant = await installTenantId().catch(() => undefined);
      if (installTenant) tenant = { tenantId: installTenant };
    }
    const secret = await postgrestSigningSecret(opts.provider);
    if (!secret) {
      if (!warnedNoSecret) {
        warnedNoSecret = true;
        console.error("[postgrest] no JWT signing secret (postgrest-jwt-secret / JWT_SECRET); database calls fail");
      }
      return failedResponse("POSTGREST_JWT_UNAVAILABLE", "[postgrest] no JWT signing secret is configured");
    }
    const role = opts.platform ? PLATFORM_DB_ROLE : await tenantDbRole();
    const headers = new Headers(request.headers);
    headers.delete("apikey");
    headers.set("Authorization", `Bearer ${signPostgrestJwt(postgrestClaims(tenant, role), secret)}`);
    const response = await fetch(url.toString(), {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      redirect: request.redirect,
      signal: request.signal,
    });
    // A rotated secret: read it again on the next call.
    if (await isJwtRejection(response)) signingSecret = undefined;
    return response;
  };
}

/**
 * The Authorization value the request client would send now, for operator
 * diagnostics that call PostgREST with raw fetch. Null on hosted Supabase or
 * with no signing secret; PostgREST then reports that call as it is.
 */
export async function postgrestRequestAuthorization(): Promise<string | null> {
  const provider = getAuthProvider();
  if (provider !== "entra" && provider !== "local") return null;
  const secret = await postgrestSigningSecret(provider);
  if (!secret) return null;
  const installTenant = currentTenant() ? undefined : await installTenantId().catch(() => undefined);
  const tenant = currentTenant() ?? (installTenant ? { tenantId: installTenant } : undefined);
  const claims = postgrestClaims(tenant, await tenantDbRole());
  return `Bearer ${signPostgrestJwt(claims, secret)}`;
}

/**
 * Server-side PostgREST client implemented with supabase-js.
 * - supabase mode: service-role JWT via SUPABASE_SECRET_KEY; default
 *   supabase-js fetch (sends to /rest/v1/<table>, which is what hosted
 *   Supabase serves).
 * - local mode: per-request JWT signed with JWT_SECRET (else Key Vault
 *   `postgrest-jwt-secret`); URL-rewrite wrapper so SUPABASE_URL can point at
 *   PostgREST directly (no proxy).
 * - entra mode: per-request JWT signed with Key Vault `postgrest-jwt-secret`.
 *   See the long comment in infra/modules/containerapp-postgrest.bicep for
 *   the trust model.
 *
 * In local and entra mode every request runs as tenant_app with the current
 * tenant (lib/tenantContext.ts), so RLS limits it to that tenant; a call made
 * outside a tenant scope is counted as `db.no_tenant_context` and runs as the
 * install's tenant (none on a pooled install, so it sees no rows). Code that
 * is cross-tenant by design uses
 * `createPlatformSupabase()` instead.
 */
export function createServerSupabase(): Db {
  return adminClient("request");
}

/**
 * The client for work that is cross-tenant by design: migrations and startup
 * probes, catalog sync, job claiming, retention sweeps, control-plane
 * functions. It always sends service_role with no tenant and never counts as
 * a missing tenant context. Importers are allowlisted in
 * `src/__tests__/architecture.test.ts` (issue 004). Hosted-supabase mode has
 * no wrapper, so there it is the same client as createServerSupabase().
 */
export function createPlatformSupabase(): Db {
  return adminClient("platform");
}

function adminClient(scope: "request" | "platform"): Db {
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

  // Hosted Supabase has a single client for both scopes.
  const cacheScope = provider === "entra" || provider === "local" ? scope : "request";
  const cached = cachedAdminClients.get(cacheScope);
  if (
    cached?.url === url &&
    cached.key === key &&
    cached.provider === provider
  ) {
    return cached.client;
  }

  let client: SupabaseClient<any, "public", any>;
  const platform = cacheScope === "platform";

  if (provider === "entra") {
    // The "key" arg is required by supabase-js but never reaches PostgREST
    // — the fetch wrapper replaces or deletes the Authorization and apikey
    // headers before the request leaves the process.
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: postgrestFetchWrapper({ provider: "entra", platform }) },
    });
  } else if (provider === "local") {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: postgrestFetchWrapper({ provider: "local", platform }) },
    });
  } else {
    // Hosted Supabase keeps its /rest/v1 path and service-role credential.
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  cachedAdminClients.set(cacheScope, { url, key, provider, client });
  return client;
}
