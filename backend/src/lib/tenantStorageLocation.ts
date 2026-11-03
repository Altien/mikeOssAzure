// Where a tenant's files live (multi-tenant issue 010).
//
// The tenant registry (`tenants`, migration 0181) records a storage account
// and container per tenant, written by the control plane
// (`cp_set_storage_location`, issue 018). NULL columns mean "the install's
// configured location", which is every row on a single-tenant install.
//
// The lookup runs as the tenant it asks about (runWithTenant), the same way
// `tenantAccess` reads its own `tenants` row, so it needs no platform client
// and stays within that tenant's rows once RLS is forced (issue 008).

import { runWithTenant } from "./tenantContext";
import { createServerSupabase } from "./supabase";

export interface TenantStorageLocation {
  /** Azure Storage account name; null = the install's configured account. */
  readonly account: string | null;
  /** Container (bucket on R2); null = the install's configured container. */
  readonly container: string | null;
  /** Placement region recorded by the control plane (informational). */
  readonly region: string | null;
}

const NO_LOCATION: TenantStorageLocation = Object.freeze({ account: null, container: null, region: null });

// Registry rows change only when the control plane moves a tenant, so a
// short cache spares a round trip per storage call. Failures are cached
// briefly too, so an unreadable registry is not re-queried on every call.
const LOCATION_TTL_MS = 5 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 1000;
const cache = new Map<string, { at: number; location?: TenantStorageLocation; error?: unknown }>();

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function loadLocation(tenantId: string): Promise<TenantStorageLocation> {
  const { data, error } = await runWithTenant({ tenantId }, async () =>
    await createServerSupabase()
      .from("tenants")
      .select("storage_account, storage_container, region")
      .eq("tenant_id", tenantId)
      .maybeSingle(),
  );
  if (error) throw new Error("Unable to read the tenant storage location", { cause: error });
  if (!data) return NO_LOCATION;
  const row = data as Record<string, unknown>;
  return {
    account: text(row.storage_account),
    container: text(row.storage_container),
    region: text(row.region),
  };
}

/**
 * The registered storage location of `tenantId`. A tenant without a row, or
 * with NULL columns, gets all-null (use the install's configuration). Throws
 * when the registry cannot be read; the caller decides whether that may fall
 * back (install tenant) or must fail closed (any other tenant).
 */
export async function tenantStorageLocation(tenantId: string): Promise<TenantStorageLocation> {
  const hit = cache.get(tenantId);
  if (hit) {
    const age = Date.now() - hit.at;
    if (hit.location && age < LOCATION_TTL_MS) return hit.location;
    if (hit.error !== undefined && age < FAILURE_TTL_MS) throw hit.error;
  }
  try {
    const location = await loadLocation(tenantId);
    cache.set(tenantId, { at: Date.now(), location });
    return location;
  } catch (error) {
    cache.set(tenantId, { at: Date.now(), error });
    throw error;
  }
}

/** Test seam, and the hook a control-plane move can call to apply at once. */
export function resetTenantStorageLocationCache(): void {
  cache.clear();
}
