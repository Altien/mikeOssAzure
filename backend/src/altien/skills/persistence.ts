import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  deleteFile,
  normalizeDownloadFilename,
  uploadFile,
} from "../../lib/storage";
import { createServerSupabase } from "../../lib/supabase";
import { briefEligibleRequirements } from "./artifacts";
import type {
  DiscoveredSkill,
  SkillSnapshotFile,
  ValidatedSkillSnapshot,
} from "./archive";
import {
  exactArrayBuffer,
  loadSkillVersionContext,
  throwOnDbError,
  type Db,
} from "./shared";

/**
 * How an incoming skill was tied to an existing tenant skill.
 *
 * `content_hash` and `github_source` are strong evidence: the import is the
 * same artifact, or the same repository entrypoint, so it becomes a new draft
 * version of the prior skill. `zip_source` (matching source filename and
 * entrypoint set) and `declared_name` are only suggestive — spec OSS-7 states
 * ZIP identity is never silently inferred solely from frontmatter name — so
 * they are reported as a possible match for explicit confirmation in the
 * import review conversation and the draft stays a separate skill.
 */
export type SkillIdentityEvidence =
  | "content_hash"
  | "github_source"
  | "zip_source"
  | "declared_name";

export type SkillIdentityCandidate = {
  skillId: string;
  canonicalName: string;
  displayName: string;
  matchedOn: SkillIdentityEvidence;
};

export type StoredSkillDraft = {
  id: string;
  canonicalName: string;
  displayName: string;
  description: string;
  isUpdate?: boolean;
  /** Set when a prior skill looks related but the evidence is not conclusive. */
  possibleMatch?: SkillIdentityCandidate;
  version: {
    id: string;
    state: "draft";
    entrypointPath: string;
    declaredVersion?: string;
    contentHash: string;
  };
};

export type StoredSkillSnapshot = {
  id: string;
  treeHash: string;
  projectId: string;
  rootFolderId: string;
  sourceDocumentId: string;
  sourceDocumentVersionId: string;
  skills: StoredSkillDraft[];
};

function tenantKey(tenantId: string): string {
  return createHash("sha256").update(tenantId).digest("hex").slice(0, 24);
}

function libraryOwner(tenantId: string) {
  return `system:skill-library:${tenantKey(tenantId)}`;
}

function libraryProvenance(tenantId: string) {
  return `skill-library:${tenantKey(tenantId)}`;
}

function storageExtension(relativePath: string): string {
  const extension = path.posix.extname(relativePath).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(extension) ? extension : ".bin";
}

function skillStoragePath(
  owner: string,
  documentId: string,
  versionId: string,
  relativePath: string,
) {
  return `documents/${owner}/${documentId}/versions/${versionId}${storageExtension(relativePath)}`;
}

function canonicalName(value: string): string {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "imported-skill"
  );
}

function allocateCanonicalName(
  declaredName: string,
  reserved: Set<string>,
): string {
  const base = canonicalName(declaredName);
  let candidate = base;
  let suffix = 2;
  while (reserved.has(candidate)) {
    const suffixText = `-${suffix}`;
    candidate = `${base.slice(0, 64 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  reserved.add(candidate);
  return candidate;
}

async function ensureLibraryProject(
  tenantId: string,
  db: Db,
): Promise<string> {
  const provenance = libraryProvenance(tenantId);
  const find = () =>
    db
      .from("projects")
      .select("id")
      .eq("project_kind", "skill_library")
      .eq("provenance_key", provenance)
      .maybeSingle();
  const existing = await find();
  throwOnDbError(existing, "Failed to find Skills library project.");
  if (existing.data?.id) return String(existing.data.id);

  const inserted = await db
    .from("projects")
    .insert({
      user_id: libraryOwner(tenantId),
      name: "Imported Skills",
      visibility: "private",
      project_kind: "skill_library",
      provenance_key: provenance,
    })
    .select("id")
    .single();
  if (!inserted.error && inserted.data?.id) return String(inserted.data.id);

  const concurrent = await find();
  throwOnDbError(concurrent, "Failed to create Skills library project.");
  if (!concurrent.data?.id) {
    throw new Error(
      inserted.error?.message ?? "Failed to create Skills library project.",
    );
  }
  return String(concurrent.data.id);
}

type PreparedFile = {
  file: SkillSnapshotFile;
  documentId: string;
  versionId: string;
  storagePath: string;
};

async function deleteUploaded(storagePaths: string[]) {
  await Promise.all(
    storagePaths.map((storagePath) =>
      deleteFile(storagePath).catch(() => undefined),
    ),
  );
}

/**
 * Rolls a failed import's rows back, in the order the foreign keys require
 * (migration 0027):
 *
 * - `altien_skill_versions.snapshot_id` is `on delete restrict`, so every
 *   version row this import wrote must go before the snapshot. Deleting the
 *   skills only cascades the versions of skills *this* import created; a
 *   version added to a pre-existing skill has to be deleted explicitly, or
 *   the snapshot delete fails and leaves an orphan version, snapshot, and
 *   document set pointing at blobs that have already been removed.
 * - The snapshot references the source document rows, so it goes before them.
 *
 * Every delete is best-effort per row: the original import failure is the one
 * worth reporting.
 */
async function bestEffortRowCleanup(args: {
  db: Db;
  versionIds: string[];
  skillIds: string[];
  snapshotId: string;
  documentIds: string[];
  rootFolderId?: string;
}) {
  for (const versionId of args.versionIds) {
    try {
      await args.db.from("altien_skill_versions").delete().eq("id", versionId);
    } catch {
      // Preserve the original import failure.
    }
  }
  for (const skillId of args.skillIds) {
    try {
      await args.db.from("altien_skills").delete().eq("id", skillId);
    } catch {
      // Preserve the original import failure.
    }
  }
  try {
    await args.db
      .from("altien_skill_import_snapshots")
      .delete()
      .eq("id", args.snapshotId);
  } catch {
    // Preserve the original import failure.
  }
  for (const documentId of args.documentIds) {
    try {
      await args.db.from("documents").delete().eq("id", documentId);
    } catch {
      // Preserve the original import failure.
    }
  }
  if (args.rootFolderId) {
    try {
      await args.db
        .from("project_subfolders")
        .delete()
        .eq("id", args.rootFolderId);
    } catch {
      // Preserve the original import failure.
    }
  }
}

function isStrongEvidence(evidence: SkillIdentityEvidence): boolean {
  return evidence === "content_hash" || evidence === "github_source";
}

/**
 * The import is byte-for-byte a version the skill already has.
 *
 * `altien_skill_versions` carries `unique(skill_id, original_content_hash)`
 * (migration 0027), so re-importing an unchanged ZIP or an unchanged commit
 * used to surface as a raw Postgres duplicate-key error. Mike's content hash
 * is authoritative for version identity, so the right answer is not a new row
 * but a refusal the administrator can act on.
 */
export class SkillImportDuplicateError extends Error {
  readonly code = "SKILL_IMPORT_DUPLICATE";
  constructor(message = "This exact version was already imported.") {
    super(message);
    this.name = "SkillImportDuplicateError";
  }
}

/**
 * Refusal to delete an imported version, naming which relationship blocks it.
 * Distinct from a generic failure so the route can answer with the reason
 * rather than a 500.
 */
export class SkillVersionDeletionRefusedError extends Error {
  constructor(
    readonly code:
      | "version_not_draft"
      | "chat_binding_exists"
      | "dependent_version_exists"
      | "project_pin_exists",
    message: string,
  ) {
    super(message);
    this.name = "SkillVersionDeletionRefusedError";
  }
}

function sameEntrypointSet(a: unknown, b: string[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  const left = [...a].map(String).sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

/**
 * Decides how much the incoming skill actually proves about being the same
 * skill as `candidateSkillId` (which matched only by canonical declared name).
 */
async function identityEvidence(args: {
  db: Db;
  tenantId: string;
  candidateSkillId: string;
  entrypointPath: string;
  entrypointSha256: string;
  sourceKind: "zip" | "github";
  sourceFilename: string;
  entrypointPaths: string[];
  github?: { repository: string; selectedPath: string };
}): Promise<SkillIdentityEvidence> {
  const versions = await args.db
    .from("altien_skill_versions")
    .select("id, snapshot_id, entrypoint_path, original_content_hash")
    .eq("skill_id", args.candidateSkillId);
  throwOnDbError(versions, "Failed to resolve prior skill versions.");
  const versionRows = (versions.data ?? []) as Array<Record<string, unknown>>;
  if (
    versionRows.some(
      (row) => String(row.original_content_hash ?? "") === args.entrypointSha256,
    )
  ) {
    return "content_hash";
  }
  const snapshotIds = [
    ...new Set(
      versionRows
        .map((row) => String(row.snapshot_id ?? ""))
        .filter((value) => !!value),
    ),
  ];
  if (!snapshotIds.length) return "declared_name";
  const snapshots = await args.db
    .from("altien_skill_import_snapshots")
    .select(
      "id, source_kind, source_filename, github_repository, github_selected_path, manifest",
    )
    .eq("tenant_id", args.tenantId)
    .in("id", snapshotIds);
  throwOnDbError(snapshots, "Failed to resolve prior skill provenance.");
  const snapshotById = new Map(
    ((snapshots.data ?? []) as Array<Record<string, unknown>>).map(
      (row) => [String(row.id), row] as const,
    ),
  );
  let weak: SkillIdentityEvidence = "declared_name";
  for (const row of versionRows) {
    const snapshot = snapshotById.get(String(row.snapshot_id ?? ""));
    if (!snapshot) continue;
    if (
      args.sourceKind === "github" &&
      snapshot.source_kind === "github" &&
      !!args.github?.repository &&
      String(snapshot.github_repository ?? "") === args.github.repository &&
      String(snapshot.github_selected_path ?? "") ===
        (args.github.selectedPath ?? "") &&
      String(row.entrypoint_path ?? "") === args.entrypointPath
    ) {
      return "github_source";
    }
    if (
      args.sourceKind === "zip" &&
      snapshot.source_kind === "zip" &&
      String(snapshot.source_filename ?? "") === args.sourceFilename &&
      sameEntrypointSet(
        (snapshot.manifest as { entrypoints?: unknown } | null)?.entrypoints,
        args.entrypointPaths,
      )
    ) {
      weak = "zip_source";
    }
  }
  return weak;
}

export async function storeSkillSnapshot(args: {
  tenantId: string;
  importedBy: string;
  sourceFilename: string;
  sourceBytes: Uint8Array;
  snapshot: ValidatedSkillSnapshot;
  sourceKind?: "zip" | "github";
  github?: {
    repository: string;
    selectedPath: string;
    requestedRef: string;
    resolvedCommitSha: string;
  };
  db?: Db;
}): Promise<StoredSkillSnapshot> {
  const db = args.db ?? createServerSupabase();
  const owner = libraryOwner(args.tenantId);
  const snapshotId = randomUUID();
  const sourceDocumentId = randomUUID();
  const sourceDocumentVersionId = randomUUID();
  const sourceStoragePath = skillStoragePath(
    owner,
    sourceDocumentId,
    sourceDocumentVersionId,
    "skills.zip",
  );
  const preparedFiles: PreparedFile[] = args.snapshot.files.map((file) => {
    const documentId = randomUUID();
    const versionId = randomUUID();
    return {
      file,
      documentId,
      versionId,
      storagePath: skillStoragePath(
        owner,
        documentId,
        versionId,
        file.relativePath,
      ),
    };
  });
  const uploaded: string[] = [];

  try {
    await uploadFile(
      sourceStoragePath,
      exactArrayBuffer(args.sourceBytes),
      "application/zip",
    );
    uploaded.push(sourceStoragePath);
    for (const item of preparedFiles) {
      await uploadFile(
        item.storagePath,
        exactArrayBuffer(item.file.bytes),
        item.file.mediaType,
      );
      uploaded.push(item.storagePath);
    }
  } catch (error) {
    await deleteUploaded(uploaded);
    throw error;
  }

  const skillIds: string[] = [];
  const versionIds: string[] = [];
  const documentIds = [
    sourceDocumentId,
    ...preparedFiles.map((item) => item.documentId),
  ];
  let rootFolderId: string | undefined;
  try {
    const projectId = await ensureLibraryProject(args.tenantId, db);
    rootFolderId = randomUUID();
    const rootFolder = await db.from("project_subfolders").insert({
      id: rootFolderId,
      project_id: projectId,
      user_id: owner,
      name: `${snapshotId}-${args.snapshot.treeHash.slice(0, 12)}`,
      parent_folder_id: null,
    });
    throwOnDbError(rootFolder, "Failed to create skill snapshot root.");

    const folderIds = new Map<string, string>([["", rootFolderId]]);
    const directoryPaths = [
      ...new Set(
        preparedFiles
          .map((item) => path.posix.dirname(item.file.relativePath))
          .filter((directory) => directory !== "."),
      ),
    ].sort((a, b) => {
      const depth = a.split("/").length - b.split("/").length;
      return depth || a.localeCompare(b, "en");
    });
    for (const directoryPath of directoryPaths) {
      const folderId = randomUUID();
      const parentPath = path.posix.dirname(directoryPath);
      const normalizedParent = parentPath === "." ? "" : parentPath;
      const inserted = await db.from("project_subfolders").insert({
        id: folderId,
        project_id: projectId,
        user_id: owner,
        name: path.posix.basename(directoryPath),
        parent_folder_id: folderIds.get(normalizedParent) ?? rootFolderId,
      });
      throwOnDbError(inserted, "Failed to preserve skill directory.");
      folderIds.set(directoryPath, folderId);
    }

    const documentRows = [
      {
        id: sourceDocumentId,
        project_id: projectId,
        user_id: owner,
        status: "ready",
        folder_id: null,
      },
      ...preparedFiles.map((item) => {
        const directory = path.posix.dirname(item.file.relativePath);
        return {
          id: item.documentId,
          project_id: projectId,
          user_id: owner,
          status: "ready",
          folder_id: folderIds.get(directory === "." ? "" : directory),
        };
      }),
    ];
    const insertedDocuments = await db.from("documents").insert(documentRows);
    throwOnDbError(insertedDocuments, "Failed to create skill DMS documents.");

    const sourceFilename =
      normalizeDownloadFilename(args.sourceFilename) || "skills.zip";
    const versionRows = [
      {
        id: sourceDocumentVersionId,
        document_id: sourceDocumentId,
        storage_path: sourceStoragePath,
        source: "skill_import",
        version_number: 1,
        filename: sourceFilename,
        file_type: "application/zip",
        size_bytes: args.sourceBytes.byteLength,
      },
      ...preparedFiles.map((item) => ({
        id: item.versionId,
        document_id: item.documentId,
        storage_path: item.storagePath,
        source: "skill_import",
        version_number: 1,
        filename: path.posix.basename(item.file.relativePath),
        file_type: item.file.mediaType,
        size_bytes: item.file.byteSize,
      })),
    ];
    const insertedVersions = await db
      .from("document_versions")
      .insert(versionRows);
    throwOnDbError(insertedVersions, "Failed to create skill DMS versions.");
    for (const row of versionRows) {
      const updated = await db
        .from("documents")
        .update({ current_version_id: row.id })
        .eq("id", row.document_id);
      throwOnDbError(updated, "Failed to activate skill DMS version.");
    }

    const fileManifest = preparedFiles.map((item) => ({
      path: item.file.relativePath,
      sha256: item.file.sha256,
      bytes: item.file.byteSize,
      media_type: item.file.mediaType,
      inspection_class: item.file.inspectionClass,
      document_id: item.documentId,
      document_version_id: item.versionId,
    }));
    const snapshotRow = await db.from("altien_skill_import_snapshots").insert({
      id: snapshotId,
      tenant_id: args.tenantId,
      imported_by: args.importedBy,
      source_kind: "zip",
      source_filename: sourceFilename,
      dms_project_id: projectId,
      root_folder_id: rootFolderId,
      source_document_id: sourceDocumentId,
      source_document_version_id: sourceDocumentVersionId,
      manifest: {
        files: fileManifest,
        entrypoints: args.snapshot.skills.map((skill) => skill.entrypointPath),
        licence_paths: args.snapshot.licencePaths,
        warnings: args.snapshot.warnings,
        mcp_requirements: args.snapshot.mcpRequirements ?? [],
      },
      tree_hash: args.snapshot.treeHash,
      expanded_bytes: args.snapshot.expandedBytes,
      file_count: args.snapshot.files.length,
      status: "stored",
      ...(args.sourceKind === "github"
        ? {
            source_kind: "github",
            github_repository: args.github?.repository,
            github_selected_path: args.github?.selectedPath,
            github_requested_ref: args.github?.requestedRef,
            github_resolved_commit_sha: args.github?.resolvedCommitSha,
          }
        : {}),
    });
    throwOnDbError(snapshotRow, "Failed to create skill import snapshot.");

    const existing = await db
      .from("altien_skills")
      .select("id, canonical_name, display_name")
      .eq("tenant_id", args.tenantId);
    throwOnDbError(existing, "Failed to resolve existing skill names.");
    const reserved = new Set(
      (existing.data ?? []).map((row: { canonical_name: string }) =>
        String(row.canonical_name),
      ),
    );
    const existingByCanonical = new Map(
      (existing.data ?? []).map(
        (row: {
          id: string;
          canonical_name: string;
          display_name: string;
        }) => [String(row.canonical_name), row],
      ),
    );
    const drafts: StoredSkillDraft[] = [];
    for (const skill of args.snapshot.skills) {
      const declaredCanonical = canonicalName(skill.declaredName);
      const candidateRow = existingByCanonical.get(declaredCanonical) ?? null;
      const entrypointFile = preparedFiles.find(
        (item) => item.file.relativePath === skill.entrypointPath,
      );
      if (!entrypointFile) {
        throw new Error("Skill entrypoint was not persisted.");
      }
      const evidence = candidateRow
        ? await identityEvidence({
            db,
            tenantId: args.tenantId,
            candidateSkillId: String(candidateRow.id),
            entrypointPath: skill.entrypointPath,
            entrypointSha256: entrypointFile.file.sha256,
            sourceKind: args.sourceKind ?? "zip",
            sourceFilename,
            entrypointPaths: args.snapshot.skills.map(
              (item) => item.entrypointPath,
            ),
            github: args.github,
          })
        : null;
      const linkedSkill = evidence && isStrongEvidence(evidence)
        ? candidateRow
        : null;
      const possibleMatch: SkillIdentityCandidate | undefined =
        evidence && !isStrongEvidence(evidence) && candidateRow
          ? {
              skillId: String(candidateRow.id),
              canonicalName: String(candidateRow.canonical_name),
              displayName: String(candidateRow.display_name),
              matchedOn: evidence,
            }
          : undefined;
      const existingSkill = linkedSkill;
      if (existingSkill) {
        // `unique(skill_id, original_content_hash)` would reject this insert
        // with a duplicate-key error. Say what actually happened instead.
        const duplicate = await db
          .from("altien_skill_versions")
          .select("id")
          .eq("skill_id", String(existingSkill.id))
          .eq("original_content_hash", entrypointFile.file.sha256)
          .maybeSingle();
        throwOnDbError(duplicate, "Failed to check for a duplicate import.");
        if (duplicate.data) {
          throw new SkillImportDuplicateError(
            `This exact version was already imported as '${String(existingSkill.display_name)}'.`,
          );
        }
      }
      const draft = existingSkill
        ? {
            skillId: String(existingSkill.id),
            versionId: randomUUID(),
            canonicalName: String(existingSkill.canonical_name),
          }
        : createDraftIdentity(skill, reserved);
      if (!existingSkill) {
        skillIds.push(draft.skillId);
        const skillRow = await db.from("altien_skills").insert({
          id: draft.skillId,
          tenant_id: args.tenantId,
          canonical_name: draft.canonicalName,
          display_name: skill.declaredName,
          description: skill.description,
          created_by: args.importedBy,
          updated_by: args.importedBy,
        });
        throwOnDbError(skillRow, "Failed to create imported skill.");
        existingByCanonical.set(draft.canonicalName, {
          id: draft.skillId,
          canonical_name: draft.canonicalName,
          display_name: skill.declaredName,
        });
      }
      const entrypoint = entrypointFile;
      versionIds.push(draft.versionId);
      const versionRow = await db.from("altien_skill_versions").insert({
        id: draft.versionId,
        skill_id: draft.skillId,
        snapshot_id: snapshotId,
        entrypoint_path: skill.entrypointPath,
        root_path: skill.rootPath,
        declared_name: skill.declaredName,
        declared_version: skill.declaredVersion ?? null,
        declared_metadata: skill.frontmatter,
        original_content_hash: entrypoint.file.sha256,
        state: "draft",
        deterministic_analysis: {
          licence_paths: skill.licencePaths,
          warnings: args.snapshot.warnings,
          mcp_requirements: args.snapshot.mcpRequirements ?? [],
          identity: {
            declared_canonical_name: declaredCanonical,
            matched_on: evidence ?? null,
            linked_prior_skill_id: existingSkill
              ? String(existingSkill.id)
              : null,
            possible_match: possibleMatch ?? null,
          },
        },
      });
      throwOnDbError(versionRow, "Failed to create imported skill version.");
      drafts.push({
        id: draft.skillId,
        canonicalName: draft.canonicalName,
        displayName: skill.declaredName,
        description: skill.description,
        isUpdate: !!existingSkill,
        ...(possibleMatch ? { possibleMatch } : {}),
        version: {
          id: draft.versionId,
          state: "draft",
          entrypointPath: skill.entrypointPath,
          declaredVersion: skill.declaredVersion,
          contentHash: entrypoint.file.sha256,
        },
      });
    }
    return {
      id: snapshotId,
      treeHash: args.snapshot.treeHash,
      projectId,
      rootFolderId,
      sourceDocumentId,
      sourceDocumentVersionId,
      skills: drafts,
    };
  } catch (error) {
    await bestEffortRowCleanup({
      db,
      versionIds,
      skillIds,
      snapshotId,
      documentIds,
      rootFolderId,
    });
    await deleteUploaded(uploaded);
    throw error;
  }
}

function createDraftIdentity(
  skill: DiscoveredSkill,
  reserved: Set<string>,
) {
  return {
    skillId: randomUUID(),
    versionId: randomUUID(),
    canonicalName: allocateCanonicalName(skill.declaredName, reserved),
  };
}

export async function listTenantSkills(
  tenantId: string,
  options: { includeDrafts: boolean },
  db: Db = createServerSupabase(),
) {
  const skills = await db
    .from("altien_skills")
    .select("*")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  throwOnDbError(skills, "Failed to list skills.");
  const skillRows = (skills.data ?? []) as Array<Record<string, unknown>>;
  if (!skillRows.length) return [];
  const versions = await db
    .from("altien_skill_versions")
    .select("*")
    .in(
      "skill_id",
      skillRows.map((skill) => String(skill.id)),
    )
    .order("created_at", { ascending: false });
  throwOnDbError(versions, "Failed to list skill versions.");
  const versionRows = (versions.data ?? []) as Array<Record<string, unknown>>;
  const snapshotIds = [
    ...new Set(
      versionRows
        .map((version) => version.snapshot_id)
        .filter(
          (value): value is string =>
            typeof value === "string" && !!value.trim(),
        ),
    ),
  ];
  const snapshots = snapshotIds.length
    ? await db
        .from("altien_skill_import_snapshots")
        .select(
          "id, source_kind, github_repository, github_resolved_commit_sha",
        )
        .in("id", snapshotIds)
    : { data: [], error: null };
  throwOnDbError(snapshots, "Failed to list skill origins.");
  const snapshotById = new Map(
    (snapshots.data ?? []).map((snapshot) => [
      String(snapshot.id),
      snapshot as Record<string, unknown>,
    ]),
  );
  return skillRows
    .map((skill) => {
      const skillVersions = versionRows.filter(
        (version) => version.skill_id === skill.id,
      );
      const visibleVersions = options.includeDrafts
        ? skillVersions
        : skillVersions.filter((version) => version.state === "enabled");
      if (!visibleVersions.length) return null;
      const currentId = String(skill.current_version_id ?? "");
      const current = options.includeDrafts
        ? visibleVersions[0]
        : visibleVersions.find((version) => version.id === currentId) ??
          visibleVersions[0];
      const origin = snapshotById.get(String(current.snapshot_id));
      return {
        id: String(skill.id),
        canonicalName: String(skill.canonical_name),
        displayName: String(skill.display_name),
        description: String(skill.description),
        ...(options.includeDrafts
          ? {
              isUpdate:
                current.state === "draft" &&
                !!skill.current_version_id &&
                String(skill.current_version_id) !== String(current.id),
            }
          : {}),
        version: {
          id: String(current.id),
          state: String(current.state),
          analysisState: String(current.analysis_state ?? "pending"),
          analysisProvider:
            current.analysis_provider == null
              ? undefined
              : String(current.analysis_provider),
          // Names a clean-room brief can be generated for. Empty means the
          // analysis found no executable or MCP gap, so the UI hides the
          // control rather than offering something that can only fail.
          briefRequirements: briefEligibleRequirements(
            current.generated_analysis as never,
            {},
          ),
          // What approving actually granted. It was only ever visible on the
          // pending action, so it disappeared at the moment it started being
          // true — leaving no way to see what an enabled skill can reach.
          approvedContract:
            (current.approved_execution_contract as Record<
              string,
              unknown
            > | null) ?? undefined,
          analysisModel:
            current.analysis_model == null
              ? undefined
              : String(current.analysis_model),
          entrypointPath: String(current.entrypoint_path),
          declaredVersion:
            current.declared_version == null
              ? undefined
              : String(current.declared_version),
          contentHash: String(
            current.adapted_content_hash ?? current.original_content_hash,
          ),
          sourceKind: String(origin?.source_kind ?? "zip"),
          sourceRepository:
            origin?.github_repository == null
              ? undefined
              : String(origin.github_repository),
          sourceCommitSha:
            origin?.github_resolved_commit_sha == null
              ? undefined
              : String(origin.github_resolved_commit_sha),
        },
      };
    })
    .filter(Boolean);
}

type ManifestDocumentRef = {
  document_id?: unknown;
  document_version_id?: unknown;
};

function manifestDocumentIds(manifest: unknown): string[] {
  const files = (manifest as { files?: ManifestDocumentRef[] } | null)?.files;
  if (!Array.isArray(files)) return [];
  return files
    .map((file) => String(file?.document_id ?? ""))
    .filter((value) => !!value);
}

/**
 * Blob locations for a set of DMS documents, read before the rows go.
 * Storage paths live on `document_versions`, which cascades away with its
 * document — so they have to be collected first or the blobs become
 * unreachable.
 */
async function storagePathsForDocuments(
  documentIds: string[],
  db: Db,
): Promise<string[]> {
  if (!documentIds.length) return [];
  const rows = await db
    .from("document_versions")
    .select("id, document_id, storage_path")
    .in("document_id", documentIds);
  throwOnDbError(rows, "Failed to resolve skill blob locations.");
  return [
    ...new Set(
      ((rows.data ?? []) as Array<Record<string, unknown>>)
        .map((row) => String(row.storage_path ?? ""))
        .filter((value) => !!value),
    ),
  ];
}

async function deleteRows(
  db: Db,
  table: string,
  column: string,
  value: string,
  failure: string,
) {
  const result = await db.from(table).delete().eq(column, value);
  throwOnDbError(result, failure);
}

async function deleteDocuments(db: Db, documentIds: string[]) {
  if (!documentIds.length) return;
  const result = await db.from("documents").delete().in("id", documentIds);
  throwOnDbError(result, "Failed to delete skill DMS documents.");
}

/** Rows of one table for a single scalar filter, as plain records. */
async function rowsWhere(
  db: Db,
  table: string,
  columns: string,
  column: string,
  value: string,
  failure: string,
): Promise<Array<Record<string, unknown>>> {
  const result = await db.from(table).select(columns).eq(column, value);
  throwOnDbError(result, failure);
  // The column list is a runtime string, so supabase cannot infer a row type.
  return (result.data ?? []) as unknown as Array<Record<string, unknown>>;
}

function bindsVersion(
  binding: Record<string, unknown>,
  versionId: string,
): boolean {
  if (String(binding.root_version_id ?? "") === versionId) return true;
  const dependencies = binding.dependency_versions;
  if (!Array.isArray(dependencies)) return false;
  return dependencies.some((entry) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    return (
      String(row.versionId ?? "") === versionId ||
      String(row.version_id ?? "") === versionId
    );
  });
}

/**
 * Refuses the delete when something still points at the version. Each check
 * names its own reason: an administrator who cannot delete needs to know which
 * relationship to unwind, not that the request failed.
 */
async function refuseIfVersionIsReferenced(args: {
  db: Db;
  tenantId: string;
  versionId: string;
}) {
  const bindings = await rowsWhere(
    args.db,
    "altien_chat_skill_bindings",
    "chat_id, root_version_id, dependency_versions",
    "tenant_id",
    args.tenantId,
    "Failed to check chat skill bindings.",
  );
  if (bindings.some((binding) => bindsVersion(binding, args.versionId))) {
    throw new SkillVersionDeletionRefusedError(
      "chat_binding_exists",
      "A chat is still bound to this skill version. Chats keep their exact root and dependency versions for their lifetime, so it cannot be deleted.",
    );
  }
  const dependents = await rowsWhere(
    args.db,
    "altien_skill_dependencies",
    "version_id, dependency_skill_id",
    "dependency_version_id",
    args.versionId,
    "Failed to check skill dependency edges.",
  );
  if (dependents.length) {
    throw new SkillVersionDeletionRefusedError(
      "dependent_version_exists",
      "Another skill version depends on this version. Remove that dependency before deleting it.",
    );
  }
  const pins = await rowsWhere(
    args.db,
    "altien_project_skill_pins",
    "project_id, skill_id",
    "version_id",
    args.versionId,
    "Failed to check project skill pins.",
  );
  if (pins.length) {
    throw new SkillVersionDeletionRefusedError(
      "project_pin_exists",
      "A project pins this skill version. Repin or remove the pin before deleting it.",
    );
  }
}

export type DeletedSkillVersion = {
  versionId: string;
  skillId: string;
  skillDeleted: boolean;
  snapshotDeleted: boolean;
  deletedDocumentCount: number;
  deletedBlobCount: number;
};

/**
 * Deletes a draft skill version and everything the import created for it.
 *
 * Only a `draft` may be deleted: an `enabled` or `disabled` version can be
 * pinned by a project or bound to a live chat, and those references are
 * `on delete restrict` precisely so a running matter cannot lose the exact
 * version it was reviewed against. Disablement, not deletion, retires a
 * promoted version (spec OSS-7, "Runtime").
 *
 * The order below is the foreign-key order of migrations 0027-0034 and follows
 * `bestEffortRowCleanup` and `discardPersistedTree`: rows that reference are
 * removed before the rows they reference, and blobs go last so no surviving
 * row ever points at a deleted blob.
 *
 *  1. clear `altien_skills.current_version_id` when it names this version
 *  2. pending actions (they reference review messages)
 *  3. review messages, then the review conversation
 *  4. this version's own dependency edges
 *  5. developer artifacts, then their DMS documents (versions cascade)
 *  6. the adapted tree's DMS documents
 *  7. the version row — after every `restrict` reference, before the folder it
 *     names (`adapted_root_folder_id`) and before its snapshot
 *     (`snapshot_id` is `on delete restrict`)
 *  8. the adapted root folder (subfolders cascade)
 *  9. the parent skill, only when this was its last version
 * 10. the snapshot, only when no other version was cut from it, then its
 *     documents (the snapshot references the source document) and finally the
 *     preserved root folder
 * 11. every blob, best effort, through the storage module
 */
export async function deleteSkillDraftVersion(args: {
  tenantId: string;
  versionId: string;
  db?: Db;
}): Promise<DeletedSkillVersion> {
  const db = args.db ?? createServerSupabase();
  const { version, skill, snapshot } = await loadSkillVersionContext({
    tenantId: args.tenantId,
    versionId: args.versionId,
    db,
  });
  const state = String(version.state ?? "");
  if (state !== "draft") {
    throw new SkillVersionDeletionRefusedError(
      "version_not_draft",
      `Only a draft version can be deleted; this version is ${state || "unknown"}. Disable the skill instead — an enabled or disabled version may be pinned or bound to a running chat.`,
    );
  }
  await refuseIfVersionIsReferenced({
    db,
    tenantId: args.tenantId,
    versionId: args.versionId,
  });

  const skillId = String(skill.id);
  const snapshotId = String(snapshot.id);
  const siblingsOfSkill = await rowsWhere(
    db,
    "altien_skill_versions",
    "id",
    "skill_id",
    skillId,
    "Failed to resolve sibling skill versions.",
  );
  const deleteSkillRow = !siblingsOfSkill.some(
    (row) => String(row.id) !== args.versionId,
  );
  const siblingsOfSnapshot = await rowsWhere(
    db,
    "altien_skill_versions",
    "id",
    "snapshot_id",
    snapshotId,
    "Failed to resolve versions sharing the import snapshot.",
  );
  const deleteSnapshotRow = !siblingsOfSnapshot.some(
    (row) => String(row.id) !== args.versionId,
  );

  const conversation = await db
    .from("altien_skill_import_conversations")
    .select("id")
    .eq("version_id", args.versionId)
    .maybeSingle();
  throwOnDbError(conversation, "Failed to resolve the import conversation.");

  const artifacts = await rowsWhere(
    db,
    "altien_skill_developer_artifacts",
    "id, document_id",
    "version_id",
    args.versionId,
    "Failed to resolve developer artifacts.",
  );
  const artifactDocumentIds = [
    ...new Set(
      artifacts
        .map((row) => String(row.document_id ?? ""))
        .filter((value) => !!value),
    ),
  ];
  const adaptedDocumentIds = manifestDocumentIds(version.adapted_manifest);
  const snapshotDocumentIds = deleteSnapshotRow
    ? [
        ...new Set(
          [
            ...manifestDocumentIds(snapshot.manifest),
            String(snapshot.source_document_id ?? ""),
          ].filter((value) => !!value),
        ),
      ]
    : [];
  const storagePaths = [
    ...(await storagePathsForDocuments(artifactDocumentIds, db)),
    ...(await storagePathsForDocuments(adaptedDocumentIds, db)),
    ...(await storagePathsForDocuments(snapshotDocumentIds, db)),
  ];

  if (String(skill.current_version_id ?? "") === args.versionId) {
    const cleared = await db
      .from("altien_skills")
      .update({ current_version_id: null })
      .eq("id", skillId)
      .eq("tenant_id", args.tenantId);
    throwOnDbError(cleared, "Failed to clear the current skill version.");
  }

  await deleteRows(
    db,
    "altien_skill_pending_actions",
    "version_id",
    args.versionId,
    "Failed to delete pending skill actions.",
  );
  if (conversation.data?.id) {
    await deleteRows(
      db,
      "altien_skill_import_messages",
      "conversation_id",
      String(conversation.data.id),
      "Failed to delete import conversation messages.",
    );
    await deleteRows(
      db,
      "altien_skill_import_conversations",
      "version_id",
      args.versionId,
      "Failed to delete the import conversation.",
    );
  }
  await deleteRows(
    db,
    "altien_skill_dependencies",
    "version_id",
    args.versionId,
    "Failed to delete skill dependency edges.",
  );
  if (artifacts.length) {
    await deleteRows(
      db,
      "altien_skill_developer_artifacts",
      "version_id",
      args.versionId,
      "Failed to delete developer artifacts.",
    );
  }
  await deleteDocuments(db, artifactDocumentIds);
  await deleteDocuments(db, adaptedDocumentIds);

  const versionRow = await db
    .from("altien_skill_versions")
    .delete()
    .eq("id", args.versionId);
  throwOnDbError(versionRow, "Failed to delete the skill version.");

  if (version.adapted_root_folder_id) {
    await deleteRows(
      db,
      "project_subfolders",
      "id",
      String(version.adapted_root_folder_id),
      "Failed to delete the adapted skill folder.",
    );
  }
  if (deleteSkillRow) {
    const skillRow = await db
      .from("altien_skills")
      .delete()
      .eq("id", skillId)
      .eq("tenant_id", args.tenantId);
    throwOnDbError(skillRow, "Failed to delete the skill.");
  }
  if (deleteSnapshotRow) {
    await deleteRows(
      db,
      "altien_skill_import_snapshots",
      "id",
      snapshotId,
      "Failed to delete the import snapshot.",
    );
    await deleteDocuments(db, snapshotDocumentIds);
    if (snapshot.root_folder_id) {
      await deleteRows(
        db,
        "project_subfolders",
        "id",
        String(snapshot.root_folder_id),
        "Failed to delete the preserved snapshot folder.",
      );
    }
  }

  await deleteUploaded(storagePaths);

  return {
    versionId: args.versionId,
    skillId,
    skillDeleted: deleteSkillRow,
    snapshotDeleted: deleteSnapshotRow,
    deletedDocumentCount:
      artifactDocumentIds.length +
      adaptedDocumentIds.length +
      snapshotDocumentIds.length,
    deletedBlobCount: storagePaths.length,
  };
}
