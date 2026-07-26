import { createServerSupabase } from "../../lib/supabase";
import { resolvedDependencyBindings } from "./dependencies";
import { getProjectSkillPin } from "./pins";
import { throwOnDbError, type Db } from "./shared";

function normalize(value: string) {
  return value.trim().toLocaleLowerCase().replace(/[\s_-]+/g, " ");
}

/**
 * Upper bound on the project documents a member may scope one skill run to.
 * Selection is a narrowing of the approved `project_read` baseline, so the
 * limit only guards the bind-time membership query.
 */
export const SKILL_RUN_MAX_SELECTED_DOCUMENTS = 50;

export function parseExplicitSkillInvocation(message: string): string | null {
  const slash = /^\s*\/skill[ \t]+([^\r\n]+)(?:\r?\n|$)/i.exec(message);
  if (slash) return slash[1].trim().replace(/^["“]|["”]$/g, "").trim() || null;
  const quoted =
    /^\s*(?:run|use|load)[ \t]+skill[ \t]+["“]([^"”\r\n]+)["”]/i.exec(
      message,
    );
  return quoted?.[1]?.trim() || null;
}

/**
 * Story 30: the documents a member selected before the skill started. Every id
 * must be a document of the run's own project — a selection can only narrow
 * what the skill may read, never reach outside the bound project.
 */
export async function resolveSelectedProjectDocuments(args: {
  projectId: string;
  documentIds: readonly unknown[];
  db: Db;
}): Promise<string[]> {
  const requested = [
    ...new Set(
      args.documentIds
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean),
    ),
  ];
  if (!requested.length) return [];
  if (requested.length > SKILL_RUN_MAX_SELECTED_DOCUMENTS) {
    throw new Error(
      `A skill run can select at most ${SKILL_RUN_MAX_SELECTED_DOCUMENTS} project documents.`,
    );
  }
  const rows = await args.db
    .from("documents")
    .select("id")
    .eq("project_id", args.projectId)
    .in("id", requested);
  throwOnDbError(rows);
  const found = new Set(
    ((rows.data ?? []) as Array<{ id: unknown }>).map((row) => String(row.id)),
  );
  if (requested.some((id) => !found.has(id))) {
    throw new Error(
      "One or more selected documents are not available in this project.",
    );
  }
  return requested;
}

export type ResolvedSkillBindingTarget = {
  versionId: string;
  contentHash: string;
  pinned: boolean;
};

/**
 * The version a chat in this project should bind to right now: the project pin
 * when one exists, otherwise the skill's current version. Shared by the first
 * bind, the upgrade offer, and the upgrade itself so an upgrade can never land
 * on a version a fresh bind would have refused.
 */
async function resolveBindableVersion(args: {
  tenantId: string;
  projectId: string;
  skillId: string;
  label: string;
  currentVersionId: string;
  db: Db;
}): Promise<ResolvedSkillBindingTarget> {
  const pin = await getProjectSkillPin({
    tenantId: args.tenantId,
    projectId: args.projectId,
    skillId: args.skillId,
    db: args.db,
  });
  const versionId = pin?.versionId ?? args.currentVersionId;
  if (!versionId) throw new Error(`Skill '${args.label}' is not enabled.`);
  const version = await args.db
    .from("altien_skill_versions")
    .select("id, skill_id, state, original_content_hash, adapted_content_hash")
    .eq("id", versionId)
    .eq("skill_id", args.skillId)
    .single();
  if (version.error || !version.data || version.data.state !== "enabled") {
    throw new Error(`Skill '${args.label}' has no runnable enabled version.`);
  }
  const contentHash = String(
    version.data.adapted_content_hash ??
      version.data.original_content_hash ??
      "",
  );
  if (!contentHash) {
    throw new Error(`Skill '${args.label}' has no recorded content hash.`);
  }
  return { versionId, contentHash, pinned: !!pin };
}

/** `resolveBindableVersion` plus the dependency re-resolution a bind records. */
async function prepareBinding(args: {
  tenantId: string;
  projectId: string;
  skillId: string;
  label: string;
  currentVersionId: string;
  db: Db;
}) {
  const target = await resolveBindableVersion(args);
  return {
    ...target,
    dependencies: await resolvedDependencyBindings(target.versionId, args.db),
  };
}

/**
 * The newer enabled version a bound chat could be upgraded to, or null. Read
 * path only: a skill whose current version is missing, disabled, or otherwise
 * unbindable simply offers no upgrade rather than failing the chat load.
 */
export async function findChatSkillUpgrade(args: {
  tenantId: string;
  projectId: string;
  skillId: string;
  label: string;
  currentVersionId: string;
  boundVersionId: string;
  db: Db;
}): Promise<ResolvedSkillBindingTarget | null> {
  if (!args.currentVersionId) return null;
  try {
    const target = await resolveBindableVersion(args);
    return target.versionId === args.boundVersionId ? null : target;
  } catch {
    return null;
  }
}

export async function bindExplicitSkillInvocation(args: {
  tenantId: string;
  projectId: string;
  chatId: string;
  userId: string;
  message: string;
  /** Story 30: project documents the member selected before the run starts. */
  selectedDocumentIds?: readonly unknown[];
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
  const selectedDocumentIds = await resolveSelectedProjectDocuments({
    projectId: args.projectId,
    documentIds: args.selectedDocumentIds ?? [],
    db,
  });
  const prepared = await prepareBinding({
    tenantId: args.tenantId,
    projectId: args.projectId,
    skillId: String(skill.id),
    label: requestedName,
    currentVersionId: String(skill.current_version_id ?? ""),
    db,
  });
  const binding = await db.from("altien_chat_skill_bindings").insert({
    chat_id: args.chatId,
    tenant_id: args.tenantId,
    project_id: args.projectId,
    root_skill_id: skill.id,
    root_version_id: prepared.versionId,
    bound_by: args.userId,
    dependency_versions: prepared.dependencies,
    selected_document_ids: selectedDocumentIds,
  });
  throwOnDbError(binding);
  return {
    skillId: String(skill.id),
    displayName: String(skill.display_name),
    versionId: prepared.versionId,
    contentHash: prepared.contentHash,
    pinned: prepared.pinned,
    dependencies: prepared.dependencies,
    selectedDocumentIds,
  };
}

/**
 * Rebinds a chat to a newer enabled version of the same skill. Only an explicit
 * user action reaches this function, and the caller must name the exact version
 * it was offered — Mike never upgrades a chat on its own, and never silently
 * substitutes a different version than the one the member saw. The bind-time
 * checks (pin resolution, enabled state, content hash, dependency
 * re-resolution) run again through the shared bind path.
 */
export async function upgradeChatSkillBinding(args: {
  tenantId: string;
  projectId: string;
  chatId: string;
  userId: string;
  /** The version id the member was shown and explicitly accepted. */
  toVersionId: string;
  db?: Db;
}) {
  const db = args.db ?? createServerSupabase();
  const requested = args.toVersionId?.trim();
  if (!requested) {
    throw new Error("An explicit target version is required to upgrade.");
  }
  const binding = await db
    .from("altien_chat_skill_bindings")
    .select("*")
    .eq("chat_id", args.chatId)
    .eq("tenant_id", args.tenantId)
    .eq("project_id", args.projectId)
    .maybeSingle();
  throwOnDbError(binding);
  if (!binding.data) throw new Error("This chat is not bound to a skill.");
  const boundVersionId = String(binding.data.root_version_id);
  const skill = await db
    .from("altien_skills")
    .select("id, display_name, current_version_id")
    .eq("id", binding.data.root_skill_id)
    .eq("tenant_id", args.tenantId)
    .is("deleted_at", null)
    .single();
  if (skill.error || !skill.data) {
    throw new Error("The bound skill is no longer available.");
  }
  const label = String(skill.data.display_name);
  const prepared = await prepareBinding({
    tenantId: args.tenantId,
    projectId: args.projectId,
    skillId: String(skill.data.id),
    label,
    currentVersionId: String(skill.data.current_version_id ?? ""),
    db,
  });
  if (prepared.versionId === boundVersionId) {
    throw new Error(`'${label}' is already at its newest enabled version.`);
  }
  if (prepared.versionId !== requested) {
    throw new Error(
      "The offered upgrade changed; review the new version before upgrading.",
    );
  }
  const updated = await db
    .from("altien_chat_skill_bindings")
    .update({
      root_version_id: prepared.versionId,
      dependency_versions: prepared.dependencies,
      upgraded_from_version_id: boundVersionId,
      upgraded_by: args.userId,
      upgraded_at: new Date().toISOString(),
    })
    .eq("chat_id", args.chatId)
    .eq("tenant_id", args.tenantId)
    .eq("project_id", args.projectId);
  throwOnDbError(updated);
  return {
    chatId: args.chatId,
    skillId: String(skill.data.id),
    displayName: label,
    previousVersionId: boundVersionId,
    versionId: prepared.versionId,
    contentHash: prepared.contentHash,
    pinned: prepared.pinned,
    dependencies: prepared.dependencies,
  };
}
