import { createServerSupabase } from "../../lib/supabase";
import { githubDeploymentAllowed } from "./github";
import {
  getGitHubSkillOAuthConnection,
  githubSkillOAuthConfigured,
} from "./githubOAuth";
import { throwOnDbError, type Db } from "./shared";

export async function getGitHubSkillImportPolicy(
  tenantId: string,
  db: Db = createServerSupabase(),
) {
  const result = await db
    .from("altien_skill_tenant_settings")
    .select("github_import_enabled")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  throwOnDbError(result);
  const deploymentAllowed = githubDeploymentAllowed();
  const tenantEnabled = result.data?.github_import_enabled === true;
  const connection = await getGitHubSkillOAuthConnection(tenantId, db);
  return {
    deploymentAllowed,
    tenantEnabled,
    effectiveEnabled: deploymentAllowed && tenantEnabled,
    oauthAvailable: await githubSkillOAuthConfigured(),
    privateRepositoryConnectionConfigured: connection.connected,
    githubLogin: connection.githubLogin,
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
  throwOnDbError(existing);
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
  throwOnDbError(write);
  return getGitHubSkillImportPolicy(args.tenantId, db);
}
