import type { Client } from "pg";
import { readStampConfiguration, type StampConfiguration } from "./stampConfiguration";

type SqlClient = Pick<Client, "query">;
const PARTITION_MONTHS = 26; // Current UTC month and at least 25 months ahead.

async function extendPartitions(db: SqlClient, now: Date): Promise<number> {
  const month = now.toISOString().slice(0, 7) + "-01";
  await db.query("select pg_advisory_xact_lock(hashtextextended('mike-ledger-partitions-v1',0))");
  let result;
  try {
    result = await db.query<{ created: number }>(
      "select app.ensure_llm_usage_partitions($1::date,$2::integer) as created", [month, PARTITION_MONTHS],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23514") {
      throw new Error("Ledger partition maintenance is blocked by rows in the default partition; reconcile those rows before retrying", { cause: error });
    }
    throw error;
  }
  const gaps = await db.query<{ object: string; problem: string }>("select object,problem from app.tenant_rls_gaps()");
  if (gaps.rows.length) throw new Error("Tenant RLS gate failed after ledger partition maintenance");
  return result.rows[0]?.created ?? 0;
}

/** Migration-owner connection only. API and workers never mutate deployment metadata. */
export async function configureStampDeployment(
  db: SqlClient,
  config: StampConfiguration,
  now = new Date(),
): Promise<number> {
  if (config.mode === "pooled" && (!config.stampId || !config.region || config.fallbackTenantId !== null)) throw new Error("Pooled deployment requires a stamp identity and no fallback");
  await db.query("begin");
  try {
    await db.query("select pg_advisory_xact_lock(hashtextextended('mike-stamp-deployment-v1',0))");
    const existing = await db.query<{ pooled: boolean; stamp_id: string | null; region: string | null }>(
      "select pooled,stamp_id,region from app.install_tenancy where singleton for update",
    );
    const previous = existing.rows[0];
    if (!previous) throw new Error("Install tenancy metadata is missing");
    if (previous.pooled && (config.mode !== "pooled"
      || (previous.stamp_id !== null && previous.stamp_id !== config.stampId)
      || (previous.region !== null && previous.region !== config.region))) {
      throw new Error("Existing pooled stamp mode and identity cannot be changed by deployment setup");
    }
    // A single-install tenant may be created later by the existing onboarding
    // path. If it already exists, forced RLS requires its claim for the lookup.
    await db.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify(config.fallbackTenantId ? { tenant_id: config.fallbackTenantId } : {}),
    ]);
    const result = await db.query(
      "update app.install_tenancy set pooled=$1,fallback_tenant_id=(select tenant_id from public.tenants where tenant_id=$2),stamp_id=$3,region=$4,updated_at=now() where singleton returning singleton",
      [config.mode === "pooled", config.fallbackTenantId, config.stampId ?? null, config.region ?? null],
    );
    if (result.rows.length !== 1) throw new Error("Install tenancy metadata is missing");
    const created = await extendPartitions(db, now);
    await db.query("commit");
    return created;
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  }
}

/** Reusable monthly maintenance entrypoint, using the same migration owner. */
export async function maintainLedgerPartitions(db: SqlClient, now = new Date()): Promise<number> {
  await db.query("begin");
  try {
    const created = await extendPartitions(db, now);
    await db.query("commit");
    return created;
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  }
}

export async function deployStampRuntime(db: SqlClient): Promise<number> {
  return configureStampDeployment(db, await readStampConfiguration());
}
