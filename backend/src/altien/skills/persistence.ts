import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  deleteFile,
  normalizeDownloadFilename,
  uploadFile,
} from "../../lib/storage";
import { createServerSupabase } from "../../lib/supabase";
import type {
  DiscoveredSkill,
  SkillSnapshotFile,
  ValidatedSkillSnapshot,
} from "./archive";
import { exactArrayBuffer, throwOnDbError, type Db } from "./shared";

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
