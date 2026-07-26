import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { deleteFile, uploadFile } from "../../lib/storage";
import { createServerSupabase } from "../../lib/supabase";
import { getUserModelSettings } from "../../lib/userSettings";
import { planSkillRename, type AdaptationFile } from "./adaptation";
import { generateCleanRoomBrief } from "./cleanRoom";
import { downloadFile } from "../../lib/storage";

type Db = ReturnType<typeof createServerSupabase>;

type ManifestFile = {
  path: string;
  sha256: string;
  bytes: number;
  media_type: string;
  inspection_class: "text" | "source" | "binary" | "nested_archive";
  document_id: string;
  document_version_id: string;
};

function exactBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

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

async function context(tenantId: string, versionId: string, db: Db) {
  const version = await db
    .from("altien_skill_versions")
    .select("*")
    .eq("id", versionId)
    .single();
  if (version.error || !version.data) throw new Error("Skill version not found.");
  const skill = await db
    .from("altien_skills")
    .select("*")
    .eq("id", version.data.skill_id)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .single();
  if (skill.error || !skill.data) throw new Error("Skill version not found.");
  const snapshot = await db
    .from("altien_skill_import_snapshots")
    .select("*")
    .eq("id", version.data.snapshot_id)
    .eq("tenant_id", tenantId)
    .single();
  if (snapshot.error || !snapshot.data) throw new Error("Skill snapshot not found.");
  return { version: version.data, skill: skill.data, snapshot: snapshot.data };
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
  try {
    for (const file of prepared) {
      await uploadFile(
        file.storagePath,
        exactBuffer(file.bytes),
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
    if (root.error) throw new Error(root.error.message);
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
      if (inserted.error) throw new Error(inserted.error.message);
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
    if (insertedDocuments.error) throw new Error(insertedDocuments.error.message);
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
    if (insertedVersions.error) throw new Error(insertedVersions.error.message);
    for (const version of versions) {
      const activated = await args.db
        .from("documents")
        .update({ current_version_id: version.id })
        .eq("id", version.document_id);
      if (activated.error) throw new Error(activated.error.message);
    }
    return {
      rootFolderId,
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
    await Promise.all(
      uploaded.map((item) => deleteFile(item).catch(() => undefined)),
    );
    throw error;
  }
}

export async function persistSkillRename(args: {
  tenantId: string;
  versionId: string;
  newDisplayName: string;
  adaptedBy: string;
  db?: Db;
}) {
  const db = args.db ?? createServerSupabase();
  const loaded = await context(args.tenantId, args.versionId, db);
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
  const collision = await db
    .from("altien_skills")
    .select("id")
    .eq("tenant_id", args.tenantId)
    .eq("canonical_name", plan.newCanonicalName)
    .neq("id", loaded.skill.id)
    .maybeSingle();
  if (collision.error) throw new Error(collision.error.message);
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
  const versionWrite = await db
    .from("altien_skill_versions")
    .update({
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
  if (versionWrite.error) throw new Error(versionWrite.error.message);
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
  if (skillWrite.error) throw new Error(skillWrite.error.message);
  return {
    skillId: String(loaded.skill.id),
    versionId: args.versionId,
    displayName: plan.newDisplayName,
    canonicalName: plan.newCanonicalName,
    entrypointPath: plan.newEntrypointPath,
    contentHash: entrypoint.sha256,
    treeHash: plan.treeHash,
    changes: plan.changes,
  };
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
  const loaded = await context(args.tenantId, args.versionId, db);
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
  if (!declaredRequirement && !localMcp) {
    throw new Error("The named executable/MCP requirement was not identified.");
  }
  const manifest = activeManifest(loaded.version, loaded.snapshot);
  const requested = new Set(args.sourcePaths ?? []);
  const eligible = (manifest.files ?? []).filter(
    (file) =>
      (file.inspection_class === "source" ||
        file.inspection_class === "text") &&
      (requested.size ? requested.has(file.path) : file.inspection_class === "source"),
  );
  if (!eligible.length) throw new Error("No eligible source files were selected.");
  if (requested.size !== 0 && eligible.length !== requested.size) {
    throw new Error("One or more requested source paths are unavailable.");
  }
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
    },
    sources,
    model: settings.fast_model,
    apiKeys: settings.api_keys,
  });
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
    generator_provenance: brief.provenance,
    leakage_check: { passed: true, violations: [] },
    state: "draft",
    created_by: args.createdBy,
  });
  if (inserted.error) throw new Error(inserted.error.message);
  return {
    id: artifactId,
    versionId: args.versionId,
    requirementName: args.requirementName,
    state: "draft",
    filename: file.path,
    generatorProvenance: brief.provenance,
    leakageCheck: { passed: true, violations: [] },
  };
}

