import { createHash } from "node:crypto";
import { createPlatformSupabase } from "./supabase";
import { runWithTenant } from "./tenantContext";

// Multi-tenant issue 008: an OAuth provider calls back without a Mike session,
// so the callback has no tenant. The state row, found by the hash of its
// unguessable token, says whose flow it is; the rest of the callback runs as
// that row's tenant and user. Only the lookup is cross-tenant.

const STATE_TABLES = {
  user_mcp_oauth_states: "user_id",
  altien_skill_github_oauth_states: "created_by",
} as const;

export type OAuthStateTable = keyof typeof STATE_TABLES;

export async function runWithOAuthStateTenant<T>(
  table: OAuthStateTable,
  state: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!state) return fn();
  const userColumn = STATE_TABLES[table];
  const { data, error } = await createPlatformSupabase()
    .from(table)
    .select(`tenant_id, ${userColumn}`)
    .eq("state_hash", createHash("sha256").update(state).digest("hex"))
    .maybeSingle();
  if (error) throw error;
  const row = data as Record<string, unknown> | null;
  const tenantId = typeof row?.tenant_id === "string" ? row.tenant_id : "";
  if (!tenantId) return fn();
  const userId = typeof row?.[userColumn] === "string" ? (row[userColumn] as string) : undefined;
  return runWithTenant({ tenantId, ...(userId ? { userId } : {}) }, fn);
}
