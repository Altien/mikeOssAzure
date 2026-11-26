// Platform lifecycle work is reachable only from a fenced durable job. Tenant
// requests cannot execute the purge RPC or obtain this platform database client.
import { createPlatformSupabase, type Db } from "../../lib/supabase";
import { currentTenant } from "../../lib/tenantContext";
import type { DbJob } from "../../lib/dbq/types";

export async function handleTenantPurge(_db: Db, job: DbJob): Promise<void> {
  const tenantId = job.tenant_id;
  if (!tenantId || tenantId !== currentTenant()?.tenantId || !job.claim_token) {
    throw new Error("Tenant purge has no matching tenant and claim fence");
  }
  const { data, error } = await createPlatformSupabase().rpc("purge_offboarded_tenant", {
    p_tenant_id: tenantId,
    p_job_id: job.id,
    p_claim_token: job.claim_token,
  });
  if (error || data !== true) throw new Error("Tenant purge did not complete", { cause: error });
}
