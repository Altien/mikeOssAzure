import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { deleteFile, downloadFile, uploadFile } from "../../lib/storage";
import { createServerSupabase } from "../../lib/supabase";
import { getUserModelSettings } from "../../lib/userSettings";
import { planSkillRename, type AdaptationFile } from "./adaptation";
import { hashActionPayload } from "./actions";
import { skillAnalysisModel } from "./settings";
import {
  CLEAN_ROOM_GENERATOR_RUN_WORDS,
  CLEAN_ROOM_SNAPSHOT_RUN_WORDS,
  collectCleanRoomGitHubSources,
  evaluateCleanRoomLeakage,
  generateCleanRoomBrief,
  type CleanRoomCoverage,
} from "./cleanRoom";
import {
  exactArrayBuffer,
  loadSkillVersionContext,
  throwOnDbError,
  type Db,
} from "./shared";

type ManifestFile = {
  path: string;
  sha256: string;
  bytes: number;
  media_type: string;
  inspection_class: "text" | "source" | "binary" | "nested_archive";
  document_id: string;
  document_version_id: string;
};

function tenantKey(tenantId: string) {
  return createHash("sha256").update(tenantId).digest("hex").slice(0, 24);
}

function ownerFor(tenantId: string) {
  return `system:skill-library:${tenantKey(tenantId)}`;
}

function extension(relativePath: string) {
  const value = path.posix.extname(relativePath).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(value) ? value : ".bin";
}

function storagePath(
  owner: string,
  documentId: string,
  versionId: string,
  relativePath: string,
) {
  return `documents/${owner}/${documentId}/versions/${versionId}${extension(relativePath)}`;
}

function originalManifest(snapshot: Record<string, unknown>) {
  return (snapshot.manifest ?? {}) as {
    files?: ManifestFile[];
    licence_paths?: string[];
    mcp_requirements?: Array<Record<string, unknown>>;
  };
}

function activeManifest(
  version: Record<string, unknown>,
  snapshot: Record<string, unknown>,
) {
  return (version.adapted_manifest ?? snapshot.manifest ?? {}) as {
    files?: ManifestFile[];
    licence_paths?: string[];
    tree_hash?: string;
  };
}

async function bytesFor(file: ManifestFile, db: Db) {
  const row = await db
    .from("document_versions")
    .select("storage_path")
    .eq("id", file.document_version_id)
    .single();
  if (row.error || !row.data?.storage_path) {
    throw new Error(`DMS file '${file.path}' is unavailable.`);
  }
  const bytes = await downloadFile(String(row.data.storage_path));
  if (!bytes) throw new Error(`DMS blob '${file.path}' is unavailable.`);
  return new Uint8Array(bytes);
}

async function persistTree(args: {
  tenantId: string;
  projectId: string;
  parentFolderId: string;
  rootName: string;
  source: string;
  files: Array<{
    path: string;
    bytes: Uint8Array;
    mediaType: string;
    inspectionClass: ManifestFile["inspection_class"];
  }>;
  db: Db;
}) {
  const owner = ownerFor(args.tenantId);
  const prepared = args.files.map((file) => {
    const documentId = randomUUID();
    const versionId = randomUUID();
    return {
      ...file,
      documentId,
      versionId,
      storagePath: storagePath(owner, documentId, versionId, file.path),
    };
  });
  const uploaded: string[] = [];
  const insertedFolderIds: string[] = [];
  const insertedDocumentIds: string[] = [];
  try {
    for (const file of prepared) {
      await uploadFile(
        file.storagePath,
        exactArrayBuffer(file.bytes),
        file.mediaType,
      );
      uploaded.push(file.storagePath);
    }
    const rootFolderId = randomUUID();
    const root = await args.db.from("project_subfolders").insert({
      id: rootFolderId,
      project_id: args.projectId,
      user_id: owner,
      name: args.rootName,
      parent_folder_id: args.parentFolderId,
    });
    throwOnDbError(root);
    insertedFolderIds.push(rootFolderId);
    const folders = new Map<string, string>([["", rootFolderId]]);
    const directoryPaths = [
      ...new Set(
        prepared
          .map((file) => path.posix.dirname(file.path))
          .filter((value) => value !== "."),
      ),
    ].sort((a, b) => {
      const depth = a.split("/").length - b.split("/").length;
      return depth || a.localeCompare(b, "en");
    });
    for (const directory of directoryPaths) {
      const folderId = randomUUID();
      const parent = path.posix.dirname(directory);
      const inserted = await args.db.from("project_subfolders").insert({
        id: folderId,
        project_id: args.projectId,
        user_id: owner,
        name: path.posix.basename(directory),
        parent_folder_id:
          folders.get(parent === "." ? "" : parent) ?? rootFolderId,
      });
      throwOnDbError(inserted);
      insertedFolderIds.push(folderId);
      folders.set(directory, folderId);
    }
    const documents = prepared.map((file) => ({
      id: file.documentId,
      project_id: args.projectId,
      user_id: owner,
      status: "ready",
      folder_id:
        folders.get(
          path.posix.dirname(file.path) === "."
            ? ""
            : path.posix.dirname(file.path),
        ) ?? rootFolderId,
    }));
    const insertedDocuments = await args.db.from("documents").insert(documents);
    throwOnDbError(insertedDocuments);
    insertedDocumentIds.push(...documents.map((document) => document.id));
    const versions = prepared.map((file) => ({
      id: file.versionId,
      document_id: file.documentId,
      storage_path: file.storagePath,
      source: args.source,
      version_number: 1,
      filename: path.posix.basename(file.path),
      file_type: file.mediaType,
      size_bytes: file.bytes.byteLength,
    }));
    const insertedVersions = await args.db
      .from("document_versions")
      .insert(versions);
    throwOnDbError(insertedVersions);
    for (const version of versions) {
      const activated = await args.db
        .from("documents")
        .update({ current_version_id: version.id })
        .eq("id", version.document_id);
      throwOnDbError(activated);
    }
    return {
      rootFolderId,
      folderIds: [...insertedFolderIds],
      storagePaths: [...uploaded],
      files: prepared.map((file) => ({
        path: file.path,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
        bytes: file.bytes.byteLength,
        media_type: file.mediaType,
        inspection_class: file.inspectionClass,
        document_id: file.documentId,
        document_version_id: file.versionId,
      })),
    };
  } catch (error) {
    await discardPersistedTree(
      {
        folderIds: insertedFolderIds,
        documentIds: insertedDocumentIds,
        storagePaths: uploaded,
      },
      args.db,
    );
    throw error;
  }
}

/**
 * Removes an adapted/clean-room tree that must not survive: DMS documents
 * (which cascade to their versions and any artifact row referencing them),
 * then the folders that held them, then the blobs. Spec OSS-7 requires a
 * failed ingestion to leave no orphan database rows behind its deleted blobs.
 */
async function discardPersistedTree(
  tree: {
    folderIds: string[];
    documentIds: string[];
    storagePaths: string[];
  },
  db: Db,
) {
  for (const documentId of tree.documentIds) {
    try {
      await db.from("documents").delete().eq("id", documentId);
    } catch {
      // Preserve the original failure.
    }
  }
  for (const folderId of [...tree.folderIds].reverse()) {
    try {
      await db.from("project_subfolders").delete().eq("id", folderId);
    } catch {
      // Preserve the original failure.
    }
  }
  await Promise.all(
    tree.storagePaths.map((item) => deleteFile(item).catch(() => undefined)),
  );
}

export async function persistSkillRename(args: {
  tenantId: string;
  versionId: string;
  newDisplayName: string;
  adaptedBy: string;
  db?: Db;
}) {
  const db = args.db ?? createServerSupabase();
  const loaded = await loadSkillVersionContext({
    tenantId: args.tenantId,
    versionId: args.versionId,
    db,
  });
  if (loaded.version.state !== "draft") {
    throw new Error("Only a draft skill version can be renamed.");
  }
  if (loaded.version.adapted_manifest) {
    throw new Error("This draft already has an adapted tree.");
  }
  const manifest = originalManifest(loaded.snapshot);
  const sourceFiles: AdaptationFile[] = [];
  for (const file of manifest.files ?? []) {
    sourceFiles.push({
      path: file.path,
      bytes: await bytesFor(file, db),
      inspectionClass: file.inspection_class,
    });
  }
  const plan = planSkillRename({
    files: sourceFiles,
    entrypointPath: String(loaded.version.entrypoint_path),
    oldDisplayName: String(loaded.skill.display_name),
    oldCanonicalName: String(loaded.skill.canonical_name),
    newDisplayName: args.newDisplayName,
  });
  const forksExistingSkill =
    !!loaded.skill.current_version_id &&
    String(loaded.skill.current_version_id) !== args.versionId;
  if (
    forksExistingSkill &&
    plan.newCanonicalName === String(loaded.skill.canonical_name)
  ) {
    throw new Error("Import as requires a different available skill name.");
  }
  const collision = await db
    .from("altien_skills")
    .select("id")
    .eq("tenant_id", args.tenantId)
    .eq("canonical_name", plan.newCanonicalName)
    .neq("id", loaded.skill.id)
    .maybeSingle();
  throwOnDbError(collision);
  if (collision.data) {
    throw new Error(`A skill named '${plan.newCanonicalName}' already exists.`);
  }
  const stored = await persistTree({
    tenantId: args.tenantId,
    projectId: String(loaded.snapshot.dms_project_id),
    parentFolderId: String(loaded.snapshot.root_folder_id),
    rootName: `adapted-${plan.newCanonicalName}-${plan.treeHash.slice(0, 12)}`,
    source: "skill_adaptation",
    files: plan.files.map((file) => {
      const original = (manifest.files ?? []).find(
        (candidate) => candidate.path === file.originalPath,
      );
      return {
        path: file.path,
        bytes: file.bytes,
        mediaType: original?.media_type ?? "application/octet-stream",
        inspectionClass:
          original?.inspection_class ?? ("binary" as const),
      };
    }),
    db,
  });
  // Anything that fails from here on must take the adapted tree with it.
  try {
    const entrypoint = stored.files.find(
      (file) => file.path === plan.newEntrypointPath,
    );
    if (!entrypoint) throw new Error("Adapted entrypoint was not persisted.");
    const adaptedManifest = {
      files: stored.files,
      licence_paths: (manifest.licence_paths ?? []).map((licencePath) => {
        const renamed = plan.files.find(
          (file) => file.originalPath === licencePath,
        );
        return renamed?.path ?? licencePath;
      }),
      tree_hash: plan.treeHash,
    };
    const targetSkillId = forksExistingSkill ? randomUUID() : String(loaded.skill.id);
    if (forksExistingSkill) {
      const createdSkill = await db.from("altien_skills").insert({
        id: targetSkillId,
        tenant_id: args.tenantId,
        canonical_name: plan.newCanonicalName,
        display_name: plan.newDisplayName,
        description: String(loaded.skill.description),
        created_by: args.adaptedBy,
        updated_by: args.adaptedBy,
      });
      throwOnDbError(createdSkill);
    }
    const versionWrite = await db
      .from("altien_skill_versions")
      .update({
        ...(forksExistingSkill ? { skill_id: targetSkillId } : {}),
        entrypoint_path: plan.newEntrypointPath,
        adapted_root_folder_id: stored.rootFolderId,
        adapted_manifest: adaptedManifest,
        adapted_content_hash: entrypoint.sha256,
        adaptation_diff: plan.changes,
        adapted_at: new Date().toISOString(),
        analysis_state: "pending",
        generated_analysis: null,
        analysis_input_hash: null,
        approved_execution_contract: null,
      })
      .eq("id", args.versionId);
    throwOnDbError(versionWrite);
    if (!forksExistingSkill) {
      const skillWrite = await db
        .from("altien_skills")
        .update({
          canonical_name: plan.newCanonicalName,
          display_name: plan.newDisplayName,
          updated_by: args.adaptedBy,
          updated_at: new Date().toISOString(),
        })
        .eq("id", loaded.skill.id)
        .eq("tenant_id", args.tenantId);
      throwOnDbError(skillWrite);
    }
    return {
      skillId: targetSkillId,
      forkedFromSkillId: forksExistingSkill
        ? String(loaded.skill.id)
        : undefined,
      versionId: args.versionId,
      displayName: plan.newDisplayName,
      canonicalName: plan.newCanonicalName,
      entrypointPath: plan.newEntrypointPath,
      contentHash: entrypoint.sha256,
      treeHash: plan.treeHash,
      changes: plan.changes,
    };
  } catch (error) {
    await discardPersistedTree(
      {
        folderIds: stored.folderIds,
        documentIds: stored.files.map((file) => file.document_id),
        storagePaths: stored.storagePaths,
      },
      db,
    );
    throw error;
  }
}

export class SkillBriefRequirementError extends Error {
  constructor(
    readonly code: "requirement_not_identified" | "remote_mcp_requirement",
    message: string,
  ) {
    super(message);
    this.name = "SkillBriefRequirementError";
  }
}

/**
 * The names a brief can actually be generated for. Naming them beats saying
 * only that the given one was wrong: the analysis already knows the answer,
 * so the administrator should not have to guess it.
 */
export function briefEligibleRequirements(
  generated: { capabilityRequirements?: Array<Record<string, unknown>> } | null,
  original: { mcp_requirements?: Array<Record<string, unknown>> },
): string[] {
  const names = new Set<string>();
  for (const item of generated?.capabilityRequirements ?? []) {
    if (item.kind === "first_party_tool" || item.kind === "mcp") {
      const name = String(item.name ?? "").trim();
      if (name) names.add(name);
    }
  }
  for (const item of original.mcp_requirements ?? []) {
    if (item.kind !== "local") continue;
    for (const value of [item.name, item.command]) {
      if (typeof value === "string" && value.trim()) names.add(value.trim());
    }
  }
  return [...names];
}

function briefRequirementHelp(
  generated: { capabilityRequirements?: Array<Record<string, unknown>> } | null,
  original: { mcp_requirements?: Array<Record<string, unknown>> },
): string {
  const eligible = briefEligibleRequirements(generated, original);
  return eligible.length
    ? `Name a requirement this analysis identified: ${eligible.join(", ")}.`
    : "This skill's analysis identified no executable or local MCP requirement, so there is nothing to specify.";
}

type ContractMapping = {
  requirement?: { name?: unknown };
  atoms?: { label?: unknown; intent?: unknown; mappedToolNames?: unknown }[];
};

/**
 * The per-behaviour result the capability matcher already produced for this
 * requirement, read back rather than recomputed.
 *
 * Re-resolving would mean a decompose call plus one match call per behaviour
 * every time somebody asks for a brief, and — as five analyses of one
 * unchanged package showed — it would not even give the same answer twice. The
 * reviewer approves a contract; a brief written against a different one would
 * describe work the reviewer never saw.
 *
 * An enabled version has its approved contract; a version still in review has
 * the one carried by its pending enable action. Neither exists before the
 * first propose, and then the brief covers the whole requirement as it always
 * did.
 */
async function requirementCoverage(
  version: Record<string, unknown>,
  versionId: string,
  requirementName: string,
  db: Db,
): Promise<CleanRoomCoverage | undefined> {
  const approved = version.approved_execution_contract as
    | { mappings?: ContractMapping[] }
    | null;
  let mappings = approved?.mappings;
  if (!mappings?.length) {
    const pending = await db
      .from("altien_skill_pending_actions")
      .select("payload, created_at")
      .eq("version_id", versionId)
      .eq("action_type", "enable_version")
      .order("created_at", { ascending: false })
      .limit(1);
    const payload = (pending.data ?? [])[0]?.payload as
      | { executionContract?: { mappings?: ContractMapping[] } }
      | undefined;
    mappings = payload?.executionContract?.mappings;
  }
  const wanted = requirementName.trim().toLocaleLowerCase();
  const mapping = (mappings ?? []).find(
    (item) =>
      String(item.requirement?.name ?? "")
        .trim()
        .toLocaleLowerCase() === wanted,
  );
  const atoms = mapping?.atoms;
  if (!Array.isArray(atoms) || !atoms.length) return undefined;
  const coverage: CleanRoomCoverage = { covered: [], uncovered: [] };
  for (const atom of atoms) {
    const label = String(atom.label ?? "").trim();
    if (!label) continue;
    const toolNames = Array.isArray(atom.mappedToolNames)
      ? atom.mappedToolNames.map(String).filter(Boolean)
      : [];
    if (toolNames.length) coverage.covered.push({ label, toolNames });
    else
      coverage.uncovered.push({
        label,
        intent: String(atom.intent ?? "").trim() || label,
      });
  }
  return coverage.covered.length || coverage.uncovered.length
    ? coverage
    : undefined;
}

/**
 * The files a scoped brief needs: those named by a behaviour nothing here
 * performs. Specifying `verify_anchors.py` does not need the three scripts
 * beside it whose jobs Mike already does.
 *
 * Falls back to every eligible file whenever no behaviour names one, so a
 * requirement whose behaviours are not file-shaped is never starved. The
 * leakage check is unaffected either way — it is run against the whole
 * snapshot regardless of what the generator was shown.
 */
function sourcesForCoverage<T extends { path: string }>(
  eligible: T[],
  coverage: CleanRoomCoverage | undefined,
  explicitlyRequested: boolean,
): T[] {
  if (!coverage?.uncovered.length || explicitlyRequested) return eligible;
  const named = eligible.filter((file) =>
    coverage.uncovered.some((atom) => {
      const label = atom.label.trim().toLocaleLowerCase();
      if (label.length < 3) return false;
      const lower = file.path.toLocaleLowerCase();
      return lower === label || lower.endsWith(`/${label}`);
    }),
  );
  return named.length ? named : eligible;
}

export async function createCleanRoomDeveloperArtifact(args: {
  tenantId: string;
  versionId: string;
  requirementName: string;
  sourcePaths?: string[];
  createdBy: string;
  db?: Db;
}) {
  const db = args.db ?? createServerSupabase();
  const loaded = await loadSkillVersionContext({
    tenantId: args.tenantId,
    versionId: args.versionId,
    db,
  });
  const generated = loaded.version.generated_analysis as
    | { capabilityRequirements?: Array<Record<string, unknown>> }
    | null;
  const declaredRequirement = generated?.capabilityRequirements?.some(
    (item) =>
      String(item.name).toLocaleLowerCase() ===
        args.requirementName.trim().toLocaleLowerCase() &&
      (item.kind === "first_party_tool" || item.kind === "mcp"),
  );
  const original = originalManifest(loaded.snapshot);
  const localMcp = (original.mcp_requirements ?? []).some(
    (item) =>
      item.kind === "local" &&
      [item.name, item.command]
        .filter((value): value is string => typeof value === "string")
        .some(
          (value) =>
            value.toLocaleLowerCase() ===
            args.requirementName.trim().toLocaleLowerCase(),
        ),
  );
  // Spec: a skill referencing an existing remote MCP requires that MCP; it is
  // not reverse-engineered. Writing a clean-room specification of somebody
  // else's hosted service is the one gap a brief must refuse to fill.
  const remoteMcp = (original.mcp_requirements ?? []).find(
    (item) =>
      item.kind === "remote" &&
      typeof item.name === "string" &&
      item.name.toLocaleLowerCase() ===
        args.requirementName.trim().toLocaleLowerCase(),
  ) as { name?: string; endpoint?: string } | undefined;
  if (remoteMcp) {
    throw new SkillBriefRequirementError(
      "remote_mcp_requirement",
      `'${args.requirementName.trim()}' is served by the remote MCP at ${remoteMcp.endpoint ?? "an external endpoint"}. Connect that MCP server in Account → Connectors; Mike does not specify a third-party hosted service.`,
    );
  }
  if (!declaredRequirement && !localMcp) {
    throw new SkillBriefRequirementError(
      "requirement_not_identified",
      briefRequirementHelp(generated, original),
    );
  }
  const manifest = activeManifest(loaded.version, loaded.snapshot);
  const requested = new Set(args.sourcePaths ?? []);
  const allEligible = (manifest.files ?? []).filter(
    (file) =>
      (file.inspection_class === "source" ||
        file.inspection_class === "text") &&
      (requested.size ? requested.has(file.path) : file.inspection_class === "source"),
  );
  if (!allEligible.length) throw new Error("No eligible source files were selected.");
  if (requested.size !== 0 && allEligible.length !== requested.size) {
    throw new Error("One or more requested source paths are unavailable.");
  }
  const coverage = await requirementCoverage(
    loaded.version,
    args.versionId,
    args.requirementName,
    db,
  );
  // An explicit sourcePaths request is the caller being specific on purpose,
  // and narrowing it further would silently drop a file they asked for.
  const eligible = sourcesForCoverage(allEligible, coverage, requested.size > 0);
  const sources = [];
  for (const file of eligible) {
    const bytes = await bytesFor(file, db);
    sources.push({
      path: file.path,
      sha256: file.sha256,
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    });
  }
  const settings = await getUserModelSettings(args.createdBy, db);
  // Explicit github.com links declared by the inspected source may be followed
  // through the same gated acquisition service the import path uses. The
  // fetched text never reaches the generator; it joins the leakage corpus, so
  // a brief cannot quietly reproduce spans of the linked upstream either.
  const linked = await collectCleanRoomGitHubSources({
    tenantId: args.tenantId,
    sources,
    db,
  });
  const brief = await generateCleanRoomBrief({
    requirementName: args.requirementName,
    provenance: {
      repository:
        loaded.snapshot.github_repository == null
          ? undefined
          : String(loaded.snapshot.github_repository),
      commitSha:
        loaded.snapshot.github_resolved_commit_sha == null
          ? undefined
          : String(loaded.snapshot.github_resolved_commit_sha),
      licencePaths: original.licence_paths ?? [],
      linkedSources: linked.notes,
    },
    sources,
    coverage,
    model: skillAnalysisModel(settings.fast_model),
    apiKeys: settings.api_keys,
  });
  // Recorded on the artifact so a reviewer sees which declared links were
  // followed — and, when the gate is off, that they were skipped rather than
  // silently ignored.
  const generatorProvenance = {
    ...brief.provenance,
    linkedGitHubSources: linked.notes,
  };
  // The generator only saw `sources`; the recorded leakage check compares the
  // brief against every readable file in the original snapshot as well.
  const snapshotTexts = [...sources];
  for (const candidate of original.files ?? []) {
    if (
      candidate.inspection_class !== "source" &&
      candidate.inspection_class !== "text"
    ) {
      continue;
    }
    if (snapshotTexts.some((source) => source.path === candidate.path)) continue;
    try {
      snapshotTexts.push({
        path: candidate.path,
        sha256: candidate.sha256,
        text: new TextDecoder("utf-8", { fatal: true }).decode(
          await bytesFor(candidate, db),
        ),
      });
    } catch {
      // A file that is unreadable as UTF-8 cannot leak as verbatim text.
    }
  }
  const snapshotLeakage = evaluateCleanRoomLeakage(
    brief.markdown,
    snapshotTexts,
    { runWords: CLEAN_ROOM_SNAPSHOT_RUN_WORDS },
  );
  // Text fetched from a declared link is held to the same strict bar as the
  // files the generator was shown, not the looser whole-snapshot bar: it is
  // third-party upstream source the brief has no business reproducing at all,
  // so a short verbatim run is already a violation.
  const linkedLeakage = evaluateCleanRoomLeakage(
    brief.markdown,
    linked.sources,
    { runWords: CLEAN_ROOM_GENERATOR_RUN_WORDS },
  );
  const leakage = {
    passed: snapshotLeakage.passed && linkedLeakage.passed,
    runWords: CLEAN_ROOM_SNAPSHOT_RUN_WORDS,
    violations: [...snapshotLeakage.violations, ...linkedLeakage.violations],
  };
  const safeName =
    args.requirementName
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "tool";
  const stored = await persistTree({
    tenantId: args.tenantId,
    projectId: String(loaded.snapshot.dms_project_id),
    parentFolderId: String(loaded.snapshot.root_folder_id),
    rootName: `developer-${safeName}-${Date.now()}`,
    source: "skill_clean_room_spec",
    files: [{
      path: `${safeName}.md`,
      bytes: new TextEncoder().encode(brief.markdown),
      mediaType: "text/markdown",
      inspectionClass: "text",
    }],
    db,
  });
  const file = stored.files[0];
  const artifactId = randomUUID();
  const leakageCheck = {
    ...leakage,
    checkedPaths: [...snapshotTexts, ...linked.sources].map(
      (source) => source.path,
    ),
  };
  // A brief that reproduces a long verbatim span from the snapshot is never
  // recorded as having passed; it is stored blocked so a reviewer can see it
  // and approval refuses it.
  const state = leakage.passed ? "draft" : "blocked";
  try {
    const inserted = await db.from("altien_skill_developer_artifacts").insert({
      id: artifactId,
      tenant_id: args.tenantId,
      version_id: args.versionId,
      requirement_name: args.requirementName,
      document_id: file.document_id,
      document_version_id: file.document_version_id,
      source_hashes: sources.map((source) => ({
        path: source.path,
        sha256: source.sha256,
      })),
      generator_provenance: generatorProvenance,
      leakage_check: leakageCheck,
      state,
      created_by: args.createdBy,
    });
    throwOnDbError(inserted);
  } catch (error) {
    await discardPersistedTree(
      {
        folderIds: stored.folderIds,
        documentIds: stored.files.map((item) => item.document_id),
        storagePaths: stored.storagePaths,
      },
      db,
    );
    throw error;
  }
  return {
    id: artifactId,
    versionId: args.versionId,
    requirementName: args.requirementName,
    state,
    filename: file.path,
    generatorProvenance,
    leakageCheck,
    reviewPayloadHash: hashActionPayload(
      developerArtifactReviewPayload({
        id: artifactId,
        version_id: args.versionId,
        requirement_name: args.requirementName,
        document_version_id: file.document_version_id,
        source_hashes: sources.map((source) => ({
          path: source.path,
          sha256: source.sha256,
        })),
        generator_provenance: generatorProvenance,
        leakage_check: leakageCheck,
        state,
      }),
    ),
  };
}

/**
 * The exact reviewable facts about a developer artifact. Approval carries the
 * hash of this payload, so — like every other pending skill action — the
 * server can prove the administrator approved what is actually stored.
 */
function developerArtifactReviewPayload(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    artifactId: String(row.id),
    versionId: String(row.version_id),
    requirementName: String(row.requirement_name),
    documentVersionId: String(row.document_version_id),
    sourceHashes: (row.source_hashes ?? []) as unknown,
    generatorProvenance: (row.generator_provenance ?? {}) as unknown,
    leakageCheck: (row.leakage_check ?? {}) as unknown,
    state: String(row.state),
  };
}

/** Hash of what a reviewer is shown for `artifactId`. */
export function developerArtifactReviewHash(
  row: Record<string, unknown>,
): string {
  return hashActionPayload(developerArtifactReviewPayload(row));
}

export async function getCleanRoomDeveloperArtifact(args: {
  tenantId: string;
  artifactId: string;
  db?: Db;
}) {
  const db = args.db ?? createServerSupabase();
  const artifact = await db
    .from("altien_skill_developer_artifacts")
    .select("*")
    .eq("id", args.artifactId)
    .eq("tenant_id", args.tenantId)
    .single();
  if (artifact.error || !artifact.data) {
    throw new Error("Developer artifact not found.");
  }
  const documentVersion = await db
    .from("document_versions")
    .select("storage_path, filename")
    .eq("id", artifact.data.document_version_id)
    .single();
  if (documentVersion.error || !documentVersion.data?.storage_path) {
    throw new Error("Developer artifact document is unavailable.");
  }
  const bytes = await downloadFile(String(documentVersion.data.storage_path));
  if (!bytes) throw new Error("Developer artifact blob is unavailable.");
  return {
    bytes,
    filename: String(documentVersion.data.filename ?? "clean-room-brief.md"),
    state: String(artifact.data.state),
    requirementName: String(artifact.data.requirement_name),
    reviewPayloadHash: developerArtifactReviewHash(artifact.data),
  };
}

export async function approveCleanRoomDeveloperArtifact(args: {
  tenantId: string;
  artifactId: string;
  approvedBy: string;
  /** Hash of the artifact facts the administrator actually reviewed. */
  reviewedPayloadHash: string;
  db?: Db;
}) {
  const db = args.db ?? createServerSupabase();
  const artifact = await db
    .from("altien_skill_developer_artifacts")
    .select("*")
    .eq("id", args.artifactId)
    .eq("tenant_id", args.tenantId)
    .single();
  if (artifact.error || !artifact.data) {
    throw new Error("Developer artifact not found.");
  }
  if (!args.reviewedPayloadHash) {
    throw new Error(
      "Developer artifact approval requires the reviewed payload hash.",
    );
  }
  if (
    developerArtifactReviewHash(artifact.data) !== args.reviewedPayloadHash
  ) {
    throw new Error(
      "The developer artifact changed since it was reviewed; review it again.",
    );
  }
  if (artifact.data.state === "blocked") {
    throw new Error("A blocked developer artifact cannot be approved.");
  }
  const updated = await db
    .from("altien_skill_developer_artifacts")
    .update({
      state: "approved",
      approved_by: args.approvedBy,
      approved_at: new Date().toISOString(),
    })
    .eq("id", args.artifactId)
    .eq("tenant_id", args.tenantId);
  throwOnDbError(updated);
  return { id: args.artifactId, state: "approved" as const };
}
