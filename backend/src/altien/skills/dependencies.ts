import { createServerSupabase } from "../../lib/supabase";
import { parseGitHubSourceUrl } from "./github";
import { loadSkillVersion, throwOnDbError, type Db } from "./shared";

export const SKILL_DEPENDENCY_MAX_DEPTH = 5;
export const SKILL_DEPENDENCY_MAX_NODES = 10;

export class SkillDependencyResolutionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly dependency: {
      versionId: string;
      skillId?: string;
      canonicalName?: string;
      displayName?: string;
      state?: string;
    },
  ) {
    super(message);
    this.name = "SkillDependencyResolutionError";
  }
}

type DependencyEdge = {
  version_id: string;
  dependency_skill_id: string;
  dependency_version_id: string;
  required: boolean;
};

const versionAndSkill = (versionId: string, tenantId: string, db: Db) =>
  loadSkillVersion({ tenantId, versionId, db });

async function edges(versionId: string, db: Db): Promise<DependencyEdge[]> {
  const result = await db
    .from("altien_skill_dependencies")
    .select("*")
    .eq("version_id", versionId);
  throwOnDbError(result);
  return (result.data ?? []) as DependencyEdge[];
}

export async function resolveSkillDependencyGraph(args: {
  rootVersionId: string;
  db: Db;
}) {
  const resolved: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  async function visit(versionId: string, depth: number) {
    if (depth > SKILL_DEPENDENCY_MAX_DEPTH) {
      throw new Error(
        `Skill dependency depth exceeds ${SKILL_DEPENDENCY_MAX_DEPTH}.`,
      );
    }
    if (visiting.has(versionId)) {
      throw new Error("Skill dependency cycle detected.");
    }
    if (visited.has(versionId)) return;
    if (visited.size >= SKILL_DEPENDENCY_MAX_NODES) {
      throw new Error(
        `Skill dependency graph exceeds ${SKILL_DEPENDENCY_MAX_NODES} versions.`,
      );
    }
    visiting.add(versionId);
    for (const edge of await edges(versionId, args.db)) {
      await visit(edge.dependency_version_id, depth + 1);
    }
    visiting.delete(versionId);
    visited.add(versionId);
    if (versionId !== args.rootVersionId) resolved.push(versionId);
  }

  await visit(args.rootVersionId, 0);
  return resolved;
}

export async function setSkillDependency(args: {
  tenantId: string;
  versionId: string;
  dependencyVersionId: string;
  required: boolean;
  approvedBy: string;
  db?: Db;
}) {
  const db = args.db ?? createServerSupabase();
  const owner = await versionAndSkill(args.versionId, args.tenantId, db);
  const dependency = await versionAndSkill(
    args.dependencyVersionId,
    args.tenantId,
    db,
  );
  if (args.versionId === args.dependencyVersionId) {
    throw new Error("A skill version cannot depend on itself.");
  }
  if (dependency.version.state !== "enabled") {
    throw new Error("Dependency version must be enabled.");
  }
  const existing = await db
    .from("altien_skill_dependencies")
    .select("*")
    .eq("version_id", args.versionId)
    .eq("dependency_skill_id", dependency.skill.id)
    .maybeSingle();
  throwOnDbError(existing);
  const payload = {
    dependency_version_id: args.dependencyVersionId,
    required: args.required,
    approved_by: args.approvedBy,
  };
  const write = existing.data
    ? await db
        .from("altien_skill_dependencies")
        .update(payload)
        .eq("version_id", args.versionId)
        .eq("dependency_skill_id", dependency.skill.id)
    : await db.from("altien_skill_dependencies").insert({
        version_id: args.versionId,
        dependency_skill_id: dependency.skill.id,
        ...payload,
      });
  throwOnDbError(write);
  try {
    await resolveSkillDependencyGraph({ rootVersionId: args.versionId, db });
  } catch (error) {
    if (existing.data) {
      await db
        .from("altien_skill_dependencies")
        .update({
          dependency_version_id: existing.data.dependency_version_id,
          required: existing.data.required,
          approved_by: existing.data.approved_by,
        })
        .eq("version_id", args.versionId)
        .eq("dependency_skill_id", dependency.skill.id);
    } else {
      await db
        .from("altien_skill_dependencies")
        .delete()
        .eq("version_id", args.versionId)
        .eq("dependency_skill_id", dependency.skill.id);
    }
    throw error;
  }
  return {
    versionId: args.versionId,
    dependencySkillId: dependency.skill.id,
    dependencyVersionId: args.dependencyVersionId,
    dependencyName: dependency.skill.display_name,
    required: args.required,
    rootSkillId: owner.skill.id,
  };
}

export async function dependencyBindings(versionId: string, db: Db) {
  const rows = await edges(versionId, db);
  const result = [];
  for (const row of rows) {
    const version = await db
      .from("altien_skill_versions")
      .select("id, skill_id, original_content_hash, adapted_content_hash, approved_execution_contract")
      .eq("id", row.dependency_version_id)
      .single();
    const skill = version.data
      ? await db
          .from("altien_skills")
          .select("id, canonical_name, display_name")
          .eq("id", version.data.skill_id)
          .single()
      : { data: null, error: null };
    if (version.error || !version.data || skill.error || !skill.data) {
      if (row.required) throw new Error("Required skill dependency is missing.");
      continue;
    }
    result.push({
      skillId: String(skill.data.id),
      canonicalName: String(skill.data.canonical_name),
      displayName: String(skill.data.display_name),
      versionId: String(version.data.id),
      contentHash: String(
        version.data.adapted_content_hash ??
          version.data.original_content_hash,
      ),
      required: row.required,
      executionContract: version.data.approved_execution_contract ?? {},
    });
  }
  return result;
}

/**
 * A dependency the imported skill declares in its own frontmatter, together
 * with the `github.com` location it names. Declaring it acquires nothing:
 * it is evidence for a proposal a TenantAdmin must authorize (story 38).
 */
export type DeclaredGitHubDependency = {
  name: string;
  url: string;
  owner: string;
  repository: string;
  ref: string | null;
  path: string | null;
};

const DEPENDENCY_KEYS = /^(dependencies|dependency|requires|required_skills)$/i;

function normalizeName(value: string) {
  return value.trim().toLocaleLowerCase().replace(/[\s-]+/g, "_");
}

function nameFor(prefix: string, parsed: ReturnType<typeof parseGitHubSourceUrl>) {
  const cleaned = prefix
    .replace(/^[-*\s]+/, "")
    .replace(/["']/g, "")
    .replace(/[:=]\s*$/, "")
    .trim();
  if (cleaned && cleaned.length <= 128) return cleaned;
  const tail = parsed.treeTail.slice(1).filter(Boolean).pop();
  return tail || parsed.repository;
}

/**
 * Deterministically reads declared dependencies out of the entrypoint
 * frontmatter. Only `https://github.com` locations are recognised — the single
 * acquisition host in this delivery — and anything unparseable is ignored
 * rather than guessed at.
 */
export function declaredGitHubDependencies(
  version: Record<string, unknown>,
): DeclaredGitHubDependency[] {
  const metadata = (version.declared_metadata ?? {}) as Record<string, unknown>;
  const found = new Map<string, DeclaredGitHubDependency>();
  for (const [key, raw] of Object.entries(metadata)) {
    if (!DEPENDENCY_KEYS.test(key) || typeof raw !== "string") continue;
    for (const line of raw.split(/[\n,]+/)) {
      const match = /https:\/\/github\.com\/\S+/i.exec(line);
      if (!match) continue;
      const url = match[0].replace(/[).,;'"]+$/, "");
      let parsed;
      try {
        parsed = parseGitHubSourceUrl(url);
      } catch {
        continue;
      }
      const treeTail = parsed.treeTail;
      const dependency: DeclaredGitHubDependency = {
        name: nameFor(line.slice(0, match.index), parsed),
        url,
        owner: parsed.owner,
        repository: `${parsed.owner}/${parsed.repository}`,
        ref: treeTail[0] ?? null,
        path: treeTail.length > 1 ? treeTail.slice(1).join("/") : null,
      };
      if (!found.has(dependency.url)) found.set(dependency.url, dependency);
    }
  }
  return [...found.values()];
}

/**
 * Declared GitHub dependencies with no approved binding on this version.
 * Nothing is fetched here; missing dependencies are never acquired silently.
 */
export async function missingDeclaredGitHubDependencies(args: {
  version: Record<string, unknown>;
  versionId: string;
  db: Db;
}): Promise<DeclaredGitHubDependency[]> {
  const declared = declaredGitHubDependencies(args.version);
  if (!declared.length) return [];
  const bound = await dependencyBindings(args.versionId, args.db);
  const boundNames = new Set(
    bound.flatMap((binding) => [
      normalizeName(binding.canonicalName),
      normalizeName(binding.displayName),
    ]),
  );
  return declared.filter(
    (dependency) => !boundNames.has(normalizeName(dependency.name)),
  );
}

export async function resolvedDependencyBindings(
  rootVersionId: string,
  db: Db,
) {
  const versionIds = await resolveSkillDependencyGraph({
    rootVersionId,
    db,
  });
  const bindings = [];
  for (const versionId of versionIds) {
    const version = await db
      .from("altien_skill_versions")
      .select("id, skill_id, state, original_content_hash, adapted_content_hash, approved_execution_contract")
      .eq("id", versionId)
      .single();
    const skill = version.data
      ? await db
          .from("altien_skills")
          .select("id, canonical_name, display_name")
          .eq("id", version.data.skill_id)
          .single()
      : { data: null, error: null };
    if (version.error || !version.data || skill.error || !skill.data) {
      throw new SkillDependencyResolutionError(
        "dependency_unavailable",
        `Skill dependency version '${versionId}' is unavailable.`,
        { versionId },
      );
    }
    const state = String(version.data.state ?? "");
    if (state !== "enabled") {
      throw new SkillDependencyResolutionError(
        "dependency_not_enabled",
        `Skill dependency '${String(skill.data.display_name)}' version '${versionId}' is ${state || "unknown"}, not enabled.`,
        {
          versionId,
          skillId: String(skill.data.id),
          canonicalName: String(skill.data.canonical_name),
          displayName: String(skill.data.display_name),
          state,
        },
      );
    }
    bindings.push({
      skillId: String(skill.data.id),
      canonicalName: String(skill.data.canonical_name),
      displayName: String(skill.data.display_name),
      versionId: String(version.data.id),
      contentHash: String(
        version.data.adapted_content_hash ??
          version.data.original_content_hash,
      ),
      executionContract: version.data.approved_execution_contract ?? {},
    });
  }
  return bindings;
}
