import { createServerSupabase } from "../../lib/supabase";
import { resolvedDependencyBindings } from "./dependencies";
import { getProjectSkillPin } from "./pins";
import { throwOnDbError, type Db } from "./shared";

function normalize(value: string) {
  return value.trim().toLocaleLowerCase().replace(/[\s_-]+/g, " ");
}

export function parseExplicitSkillInvocation(message: string): string | null {
  const slash = /^\s*\/skill[ \t]+([^\r\n]+)(?:\r?\n|$)/i.exec(message);
  if (slash) return slash[1].trim().replace(/^["“]|["”]$/g, "").trim() || null;
  const quoted =
    /^\s*(?:run|use|load)[ \t]+skill[ \t]+["“]([^"”\r\n]+)["”]/i.exec(
      message,
    );
  return quoted?.[1]?.trim() || null;
}

export async function bindExplicitSkillInvocation(args: {
  tenantId: string;
  projectId: string;
  chatId: string;
  userId: string;
  message: string;
  db?: Db;
}) {
  const requestedName = parseExplicitSkillInvocation(args.message);
  if (!requestedName) return null;
  const db = args.db ?? createServerSupabase();
  const existing = await db
    .from("altien_chat_skill_bindings")
    .select("chat_id")
    .eq("chat_id", args.chatId)
    .maybeSingle();
  throwOnDbError(existing);
  if (existing.data) throw new Error("This chat is already bound to a skill.");

  const skills = await db
    .from("altien_skills")
    .select(
      "id, canonical_name, display_name, current_version_id",
    )
    .eq("tenant_id", args.tenantId)
    .is("deleted_at", null);
  throwOnDbError(skills);
  const matches = (skills.data ?? []).filter(
    (skill) =>
      normalize(String(skill.canonical_name)) === normalize(requestedName) ||
      normalize(String(skill.display_name)) === normalize(requestedName),
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length
        ? `Skill name '${requestedName}' is ambiguous.`
        : `Enabled skill '${requestedName}' was not found.`,
    );
  }
  const skill = matches[0];
  const pin = await getProjectSkillPin({
    tenantId: args.tenantId,
    projectId: args.projectId,
    skillId: String(skill.id),
    db,
  });
  const versionId = pin?.versionId ?? String(skill.current_version_id ?? "");
  if (!versionId) throw new Error(`Skill '${requestedName}' is not enabled.`);
  const version = await db
    .from("altien_skill_versions")
    .select("id, skill_id, state, original_content_hash, adapted_content_hash")
    .eq("id", versionId)
    .eq("skill_id", skill.id)
    .single();
  if (version.error || !version.data || version.data.state !== "enabled") {
    throw new Error(`Skill '${requestedName}' has no runnable enabled version.`);
  }
  const dependencies = await resolvedDependencyBindings(versionId, db);
  const binding = await db.from("altien_chat_skill_bindings").insert({
    chat_id: args.chatId,
    tenant_id: args.tenantId,
    project_id: args.projectId,
    root_skill_id: skill.id,
    root_version_id: versionId,
    bound_by: args.userId,
    dependency_versions: dependencies,
  });
  throwOnDbError(binding);
  return {
    skillId: String(skill.id),
    displayName: String(skill.display_name),
    versionId,
    contentHash: String(
      version.data.adapted_content_hash ?? version.data.original_content_hash,
    ),
    pinned: !!pin,
    dependencies,
  };
}
