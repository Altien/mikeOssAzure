import { createServerSupabase } from "../../lib/supabase";
import { throwOnDbError, type Db } from "./shared";

export async function disableSkill(args: {
  tenantId: string;
  skillId: string;
  disabledBy: string;
  db?: Db;
}) {
  const db = args.db ?? createServerSupabase();
  const skill = await db
    .from("altien_skills")
    .select("id, current_version_id")
    .eq("id", args.skillId)
    .eq("tenant_id", args.tenantId)
    .is("deleted_at", null)
    .single();
  if (skill.error || !skill.data) throw new Error("Skill not found.");
  const versionId = skill.data.current_version_id
    ? String(skill.data.current_version_id)
    : null;
  if (versionId) {
    const disabled = await db
      .from("altien_skill_versions")
      .update({ state: "disabled" })
      .eq("id", versionId)
      .eq("skill_id", args.skillId);
    throwOnDbError(disabled);
  }
  const updated = await db
    .from("altien_skills")
    .update({
      current_version_id: null,
      updated_by: args.disabledBy,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.skillId)
    .eq("tenant_id", args.tenantId);
  throwOnDbError(updated);
  return { skillId: args.skillId, disabledVersionId: versionId };
}

