// Request-scoped tenant context (multi-tenant phase 1, issue 001).
//
// Every later tenancy layer — the PostgREST JWT claim (002), job ownership
// (003), RLS (008), storage routing (010), metering (015) — needs to know
// which tenant the current unit of work belongs to, including deep inside
// services and job handlers that only receive a `Db`. Threading a tenant
// argument through every service signature would be a large upstream
// divergence, so the tenant travels in Node's AsyncLocalStorage instead:
// `runWithTenant` opens a scope, and every `await`ed call made inside it sees
// the same `currentTenant()`.
//
// Rules:
//   - The tenant comes from the validated identity (`resolveTenant`) or from
//     a durable record we wrote ourselves (a claimed job's `tenant_id`).
//     Never from a header, body, path or query value.
//   - Unauthenticated routes (/config, /install, health) run with no context.
//   - Code that is cross-tenant by design does not run inside a scope; it uses
//     `createPlatformSupabase()` (lib/supabase.ts) instead.
//   - A supabase-js query builder is lazy: the request is issued where it is
//     AWAITED. `runWithTenant(ctx, () => db.from("x").select())` returns the
//     builder un-awaited and runs the query outside the scope; write
//     `runWithTenant(ctx, async () => await db.from("x").select())`.

import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthPrincipal } from "./auth/types";
import { getConfig } from "./config";
import type { Db } from "./supabase";
import { getTenancyMode } from "./tenancyMode";
import { findTenantMembership, findIdentitySourceTenant } from "./tenantMemberships";

export interface TenantContext {
  /** `tenants.tenant_id` — the internal tenant key. */
  readonly tenantId: string;
  /** The acting user, when the work is on behalf of one. */
  readonly userId?: string;
  /** Resolved by tenantAccess after admission; never copied to background work. */
  readonly roles?: readonly string[];
  readonly pooled?: boolean;
  readonly readOnly?: boolean;
  readonly userEmail?: string;
}

/** Tenant key used by `local` / `supabase` installs when none is configured. */
export const DEFAULT_TENANT_ID = "default";

const storage = new AsyncLocalStorage<TenantContext>();

/**
 * Run `fn` with `ctx` as the current tenant. The scope covers everything `fn`
 * awaits or schedules, and ends when `fn` settles; concurrent scopes never
 * observe each other.
 */
export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  const tenantId = typeof ctx.tenantId === "string" ? ctx.tenantId.trim() : "";
  if (!tenantId) throw new Error("runWithTenant requires a tenantId");
  const userId = ctx.userId?.trim() || undefined;
  const frozen: TenantContext = Object.freeze({ tenantId, ...(userId ? { userId } : {}),
    ...(ctx.roles ? { roles: Object.freeze([...ctx.roles]) } : {}),
    ...(ctx.pooled ? { pooled: true } : {}),
    ...(ctx.readOnly ? { readOnly: true } : {}),
    ...(ctx.userEmail ? { userEmail: ctx.userEmail } : {}),
  });
  return storage.run(frozen, fn);
}

/** The tenant of the current request or job, or undefined outside a scope. */
export function currentTenant(): TenantContext | undefined {
  return storage.getStore();
}

// ── db.no_tenant_context (issue 002) ────────────────────────────────────────
// A tenant-scoped database call made outside any tenant scope. Today such a
// call still runs as service_role; once RLS is forced (issue 008) it would see
// zero rows. Issue 004 drives this metric to zero outside the platform
// allowlist, so every occurrence is counted with where it came from.

export const NO_TENANT_CONTEXT_METRIC = "db.no_tenant_context";

const noContextCounts = new Map<string, number>();

/**
 * The first application frame of the current stack (`src/...:line`), skipping
 * this module, the database client and dependencies. supabase-js issues the
 * fetch from a thenable job, so the awaiting caller is often not on the stack;
 * the PostgREST target recorded alongside is then the useful grouping key.
 */
export function callerSite(stack = new Error().stack ?? ""): string {
  for (const line of stack.split("\n").slice(1)) {
    const frame = line.replaceAll("\\", "/");
    if (frame.includes("node_modules") || frame.includes("node:")) continue;
    if (/\/lib\/(tenantContext|supabase)\.[jt]s/.test(frame)) continue;
    const match = /\/src\/(.+?:\d+)(?::\d+)?\)?\s*$/.exec(frame);
    if (match) return match[1];
  }
  return "unknown";
}

type MetricClient = {
  trackMetric(metric: { name: string; value: number; properties?: Record<string, string> }): void;
};
let telemetry: Promise<MetricClient | undefined> | undefined;

function telemetryClient(): Promise<MetricClient | undefined> {
  // applicationinsights is initialised by src/telemetry.ts (first import of
  // every entrypoint). Resolved lazily so importing this module never loads
  // the SDK where telemetry is off (tests, local dev).
  telemetry ??= process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
    ? import("applicationinsights")
        .then((mod) => {
          const sdk = mod as unknown as { defaultClient?: unknown; default?: { defaultClient?: unknown } };
          return (sdk.defaultClient ?? sdk.default?.defaultClient) as MetricClient | undefined;
        })
        .catch(() => undefined)
    : Promise.resolve(undefined);
  return telemetry;
}

/**
 * Count one tenant-scoped database call made without a tenant context.
 * `target` is the PostgREST method and path (`GET /chats`, `POST /rpc/x`).
 * Logged once per site per process; every call is a metric sample.
 */
export function recordNoTenantContext(target: string, site = callerSite()): void {
  const key = `${site} ${target}`;
  const seen = noContextCounts.get(key) ?? 0;
  noContextCounts.set(key, seen + 1);
  if (seen === 0) console.warn(`[tenant] ${NO_TENANT_CONTEXT_METRIC}`, { site, target });
  void telemetryClient().then((client) =>
    client?.trackMetric({ name: NO_TENANT_CONTEXT_METRIC, value: 1, properties: { site, target } }),
  );
}

/** In-process counts keyed by `"<site> <target>"` (tests, diagnostics). */
export function noTenantContextCounts(): ReadonlyMap<string, number> {
  return noContextCounts;
}

export function resetNoTenantContextCounts(): void {
  noContextCounts.clear();
}

// Config lookups below fall back to defaults on every failure. getConfig does
// not cache misses (a missing Key Vault secret is a round-trip each time), so
// the resolved values are memoised here for the same TTL getConfig uses.
const RESOLVED_TTL_MS = 5 * 60 * 1000;
const resolved = new Map<string, { value: string; at: number }>();

async function cachedConfig(name: string, fallback: string): Promise<string> {
  const hit = resolved.get(name);
  if (hit && Date.now() - hit.at < RESOLVED_TTL_MS) return hit.value;
  const raw = await getConfig(name).catch(() => "");
  const value = raw.trim() || fallback;
  resolved.set(name, { value, at: Date.now() });
  return value;
}

/** Test seam: forget memoised config so a test can change env between cases. */
export function resetTenantConfigCache(): void {
  resolved.clear();
}

async function authProvider(): Promise<string> {
  const raw = await getConfig("auth-provider").catch(() => process.env.AUTH_PROVIDER ?? "");
  return (raw || "supabase").trim().toLowerCase();
}

/** The fixed tenant key of a `local` / `supabase` install (`default-tenant-id`). */
export function configuredDefaultTenantId(): Promise<string> {
  return cachedConfig("default-tenant-id", DEFAULT_TENANT_ID);
}

/**
 * Map a validated principal to its tenant. The one place the lookup lives, so
 * pooled sign-in (issues 012/021) can swap it for `tenant_identity_sources` /
 * `tenant_memberships` without touching the middleware.
 *
 *   - entra (single-tenant today): the token's `tid`, already checked against
 *     the configured `entra-tenant-id`; it is the install's existing
 *     `tenants.tenant_id`.
 *   - local / supabase: one fixed key from config (`default-tenant-id`,
 *     falling back to "default").
 *
 * Returns undefined when no tenant can be derived; `tenantAccess` then denies
 * the request (entra), so no handler runs without a tenant.
 */
export async function resolveTenant(principal: AuthPrincipal): Promise<string | undefined> {
  if (await getTenancyMode() === "pooled") {
    const directoryId = principal.directoryId;
    principal.tenantId = undefined;
    principal.membershipRole = undefined;
    if (principal.provider === "entra" && principal.identityKind === "enterprise") {
      principal.tenantId = directoryId ? await findIdentitySourceTenant(directoryId) : undefined;
    } else if ((principal.provider === "entra" && principal.identityKind === "altien")
      || (principal.provider === "local" && process.env.NODE_ENV !== "production")) {
      const membership = await findTenantMembership(principal.userId);
      principal.tenantId = membership?.tenantId;
      principal.membershipRole = membership?.role;
    }
    return principal.tenantId;
  }
  if (principal.provider === "entra") return principal.tenantId?.trim() || undefined;
  return configuredDefaultTenantId();
}

/**
 * The single tenant a single-tenant install serves: the configured
 * `entra-tenant-id` in entra mode, the default key otherwise. Used for work
 * that predates tenant columns (job rows written before migration 0179). Pooled
 * installs have no install tenant; issue 012 replaces the callers' fallback.
 */
export async function installTenantId(): Promise<string | undefined> {
  if (await getTenancyMode() === "pooled") return undefined;
  if ((await authProvider()) === "entra") {
    const tid = await cachedConfig("entra-tenant-id", "");
    return tid || undefined;
  }
  return configuredDefaultTenantId();
}

/**
 * Run background work (a claimed job, an upload, a queue message) as the
 * tenant recorded on it (issue 003). A record without one — written before
 * migration 0179, or queued by a platform sweep — runs as the install's
 * tenant; pooled installs have none, and such work then runs with no context.
 */
export async function runWithJobTenant<T>(
  tenantId: string | null | undefined,
  fn: () => Promise<T>,
  userId?: string,
): Promise<T> {
  const resolvedTenant = tenantId?.trim() || (await installTenantId());
  return resolvedTenant ? runWithTenant({ tenantId: resolvedTenant, userId }, fn) : fn();
}

/**
 * Stamp the current tenant onto a queue message that does not travel through
 * Postgres (BullMQ), so its worker can run it with `runWithJobTenant`.
 * Durable `db_jobs` rows need no stamp: their column defaults from the claim.
 */
export function stampJobTenant<T extends { tenantId?: string }>(data: T): T {
  const tenantId = data.tenantId ?? currentTenant()?.tenantId;
  return tenantId ? { ...data, tenantId } : data;
}

/**
 * Startup probe: make sure the install's tenant has a `tenants` row, so rows
 * that default their `tenant_id` from the request context satisfy the foreign
 * key. Idempotent (insert-if-absent), safe to run from every process.
 *
 * Entra installs register only under `tenant-onboarding-mode=auto`, which is
 * exactly what `tenantAccess` would do on the first sign-in; under `manual`
 * the operator's explicit onboarding stays the gate and nothing is written.
 */
export async function ensureInstallTenant(db: Db): Promise<string | undefined> {
  if (await getTenancyMode() === "pooled") return undefined;
  let tenantId: string | undefined;
  if ((await authProvider()) === "entra") {
    const onboarding = (await getConfig("tenant-onboarding-mode").catch(() => "")) || "manual";
    if (onboarding !== "auto") return undefined;
    tenantId = await installTenantId();
  } else {
    tenantId = await configuredDefaultTenantId();
  }
  if (!tenantId) return undefined;
  const { error } = await db
    .from("tenants")
    .upsert(
      { tenant_id: tenantId, status: "active" },
      { onConflict: "tenant_id", ignoreDuplicates: true },
    );
  if (error) throw new Error("Unable to register the install tenant");
  return tenantId;
}
