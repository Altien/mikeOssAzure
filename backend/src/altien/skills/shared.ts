/**
 * Internal helpers shared by the Skills modules.
 *
 * Every Skills module needs the same three things: the tenant-scoped
 * version -> skill -> snapshot lookup, a consistent way to turn a supabase
 * `{ data, error }` result into an exception, and an exact `ArrayBuffer`
 * view for storage writes. They were re-implemented per file; this module is
 * the single copy.
 */
import { createServerSupabase } from "../../lib/supabase";

export type Db = ReturnType<typeof createServerSupabase>;

export type DbResult<T = unknown> = {
  data?: T | null;
  error?: { message?: string } | null;
};

/** The `{ tenantId, versionId, db }` clump every version-scoped call carries. */
export type SkillVersionCtx = {
  tenantId: string;
  versionId: string;
  db: Db;
};

export type SkillRow = Record<string, unknown>;

export function dbMessage(result: DbResult): string | null {
  return result.error?.message ?? null;
}

export function throwOnDbError(
  result: DbResult,
  fallback = "Skill database operation failed.",
): void {
  const message = dbMessage(result);
  if (message) throw new Error(message || fallback);
}

export function requireResult<T>(result: DbResult<T>, fallback: string): T {
  const message = dbMessage(result);
  if (message || !result.data) throw new Error(message || fallback);
  return result.data;
}

/**
 * `Uint8Array.buffer` may be a larger pooled buffer; storage writes must send
 * exactly the viewed bytes.
 */
export function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/**
 * Loads a skill version and its owning skill, scoped to the tenant. A version
 * whose skill belongs to another tenant, or is soft-deleted, is reported as
 * missing rather than as a permission error.
 */
export async function loadSkillVersion(ctx: SkillVersionCtx): Promise<{
  version: SkillRow;
  skill: SkillRow;
}> {
  const version = requireResult<SkillRow>(
    await ctx.db
      .from("altien_skill_versions")
      .select("*")
      .eq("id", ctx.versionId)
      .single(),
    "Skill version not found.",
  );
  const skill = requireResult<SkillRow>(
    await ctx.db
      .from("altien_skills")
      .select("*")
      .eq("id", String(version.skill_id))
      .eq("tenant_id", ctx.tenantId)
      .is("deleted_at", null)
      .single(),
    "Skill version not found.",
  );
  return { version, skill };
}

/** `loadSkillVersion` plus the immutable import snapshot backing the version. */
export async function loadSkillVersionContext(ctx: SkillVersionCtx): Promise<{
  version: SkillRow;
  skill: SkillRow;
  snapshot: SkillRow;
}> {
  const loaded = await loadSkillVersion(ctx);
  const snapshot = requireResult<SkillRow>(
    await ctx.db
      .from("altien_skill_import_snapshots")
      .select("*")
      .eq("id", String(loaded.version.snapshot_id))
      .eq("tenant_id", ctx.tenantId)
      .single(),
    "Skill snapshot not found.",
  );
  return { ...loaded, snapshot };
}
