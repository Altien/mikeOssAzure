// Reads the per-tenant debug switches (public.tenants.debug_log_until, set
// only by the control plane through cp_set_tenant_debug / cp_clear_tenant_debug,
// migration 0201). Cross-tenant by design, like jobs/maintenance.ts.
import { createPlatformSupabase } from "../supabase";
import type { DebugSwitchRow } from "./tenantDebugSwitches";

const READ_TIMEOUT_MS = 5_000;

export async function readTenantDebugSwitches(): Promise<readonly DebugSwitchRow[]> {
  const nowIso = new Date().toISOString();
  const { data, error } = await createPlatformSupabase()
    .from("tenants")
    .select("tenant_id, debug_log_until")
    .gt("debug_log_until", nowIso)
    .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS));
  if (error) throw new Error("Could not read tenant debug switches", { cause: error });
  const rows: DebugSwitchRow[] = [];
  for (const row of (data ?? []) as Array<{ tenant_id?: unknown; debug_log_until?: unknown }>) {
    if (typeof row.tenant_id !== "string" || typeof row.debug_log_until !== "string") continue;
    rows.push({ tenantId: row.tenant_id, until: new Date(row.debug_log_until) });
  }
  return rows;
}
