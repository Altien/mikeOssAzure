import { createServerSupabase } from "../../lib/supabase";
import { throwOnDbError, type Db } from "./shared";

async function enabledTenantVersion(args: {
  tenantId: string;
  skillId: string;
  versionId: string;
  db: Db;
}) {
  const skill = await args.db
    .from("altien_skills")
    .select("id, display_name")
    .eq("id", args.skillId)
    .eq("tenant_id", args.tenantId)
    .is("deleted_at", null)
    .single();
  if (skill.error || !skill.data) throw new Error("Skill not found.");
  const version = await args.db
    .from("altien_skill_versions")
    .select("id, skill_id, state, original_content_hash, adapted_content_hash")
    .eq("id", args.versionId)
    .eq("skill_id", args.skillId)
    .single();
  if (version.error || !version.data || version.data.state !== "enabled") {
    throw new Error("Only an enabled version of this skill can be pinned.");
  }
  return { skill: skill.data, version: version.data };
}

export async function listProjectSkillPins(args: {
  tenantId: string;
  projectId: string;
  db?: Db;
}) {
  const db = args.db ?? createServerSupabase();
  const result = await db
    .from("altien_project_skill_pins")
    .select("*")
    .eq("tenant_id", args.tenantId)
    .eq("project_id", args.projectId);
  throwOnDbError(result);
  return (result.data ?? []).map((row) => ({
    skillId: String(row.skill_id),
    versionId: String(row.version_id),
    pinnedBy: String(row.pinned_by),
    updatedAt: String(row.updated_at),
  }));
}

export async function getProjectSkillPin(args: {
  tenantId: string;
  projectId: string;
  skillId: string;
  db: Db;
}) {
  const result = await args.db
    .from("altien_project_skill_pins")
    .select("*")
    .eq("tenant_id", args.tenantId)
    .eq("project_id", args.projectId)
    .eq("skill_id", args.skillId)
    .maybeSingle();
  throwOnDbError(result);
  return result.data
    ? {
        skillId: String(result.data.skill_id),
        versionId: String(result.data.version_id),
      }
    : null;
}

export async function setProjectSkillPin(args: {
  tenantId: string;
  projectId: string;
  skillId: string;
  versionId: string;
  pinnedBy: string;
  db?: Db;
}) {
  const db = args.db ?? createServerSupabase();
  const target = await enabledTenantVersion({ ...args, db });
  const existing = await getProjectSkillPin({ ...args, db });
  const payload = {
    version_id: args.versionId,
    pinned_by: args.pinnedBy,
    updated_at: new Date().toISOString(),
  };
  const write = existing
    ? await db
        .from("altien_project_skill_pins")
        .update(payload)
        .eq("tenant_id", args.tenantId)
        .eq("project_id", args.projectId)
        .eq("skill_id", args.skillId)
    : await db.from("altien_project_skill_pins").insert({
        tenant_id: args.tenantId,
        project_id: args.projectId,
        skill_id: args.skillId,
        ...payload,
      });
  throwOnDbError(write);
  return {
    projectId: args.projectId,
    skillId: args.skillId,
    skillName: String(target.skill.display_name),
    versionId: args.versionId,
    contentHash: String(
      target.version.adapted_content_hash ??
        target.version.original_content_hash,
    ),
  };
}
