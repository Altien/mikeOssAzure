import { createServerSupabase } from "../../lib/supabase";
import { githubDeploymentAllowed } from "./github";

type Db = ReturnType<typeof createServerSupabase>;

export async function getGitHubSkillImportPolicy(
  tenantId: string,
  db: Db = createServerSupabase(),
) {
  const result = await db
    .from("altien_skill_tenant_settings")
    .select("github_import_enabled")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const deploymentAllowed = githubDeploymentAllowed();
  const tenantEnabled = result.data?.github_import_enabled === true;
  return {
    deploymentAllowed,
    tenantEnabled,
    effectiveEnabled: deploymentAllowed && tenantEnabled,
    privateRepositoryConnectionConfigured:
      !!process.env.GITHUB_SKILL_IMPORT_TOKEN?.trim(),
  };
}

export async function setGitHubSkillImportPolicy(args: {
  tenantId: string;
  enabled: boolean;
  updatedBy: string;
  db?: Db;
}) {
  const db = args.db ?? createServerSupabase();
  const existing = await db
    .from("altien_skill_tenant_settings")
    .select("tenant_id")
    .eq("tenant_id", args.tenantId)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  const payload = {
    github_import_enabled: args.enabled,
    updated_by: args.updatedBy,
    updated_at: new Date().toISOString(),
  };
  const write = existing.data
    ? await db
        .from("altien_skill_tenant_settings")
        .update(payload)
        .eq("tenant_id", args.tenantId)
    : await db.from("altien_skill_tenant_settings").insert({
        tenant_id: args.tenantId,
        ...payload,
      });
  if (write.error) throw new Error(write.error.message);
  return getGitHubSkillImportPolicy(args.tenantId, db);
}
