import JSZip from "jszip";
import { downloadFile } from "../../lib/storage";
import { createServerSupabase } from "../../lib/supabase";
import {
  exactArrayBuffer,
  loadSkillVersionContext,
  throwOnDbError,
  type Db,
} from "./shared";
import {
  dependencyBindings,
  resolvedDependencyBindings,
} from "./dependencies";

async function documentVersionBytes(documentVersionId: string, db: Db) {
  const version = await db
    .from("document_versions")
    .select("storage_path")
    .eq("id", documentVersionId)
    .single();
  if (version.error || !version.data?.storage_path) {
    throw new Error("Package document version is unavailable.");
  }
  const bytes = await downloadFile(String(version.data.storage_path));
  if (!bytes) throw new Error("Package blob is unavailable.");
  return bytes;
}

export async function getSkillPackageInfo(args: {
  tenantId: string;
  versionId: string;
  db?: Db;
}) {
  const db = args.db ?? createServerSupabase();
  const loaded = await loadSkillVersionContext({
    tenantId: args.tenantId,
    versionId: args.versionId,
    db,
  });
  const manifest = (loaded.version.adapted_manifest ??
    loaded.snapshot.manifest) as {
    licence_paths?: unknown[];
    files?: unknown[];
  };
  const artifacts = await db
    .from("altien_skill_developer_artifacts")
    .select("id")
    .eq("tenant_id", args.tenantId)
    .eq("version_id", args.versionId)
    .eq("state", "approved");
  throwOnDbError(artifacts);
  return {
    versionId: args.versionId,
    skillName: String(loaded.skill.display_name),
    state: String(loaded.version.state),
    originalAvailable: !!loaded.snapshot.source_document_version_id,
    mikePackageAvailable: true,
    developerPackageAvailable: (artifacts.data ?? []).length > 0,
    developerArtifactCount: (artifacts.data ?? []).length,
    licencePaths: Array.isArray(manifest.licence_paths)
      ? manifest.licence_paths.map(String)
      : [],
    fileCount: Array.isArray(manifest.files) ? manifest.files.length : 0,
    treeHash: String(loaded.snapshot.tree_hash),
  };
}

function safePackageSegment(value: string) {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "tool"
  );
}

export async function buildOriginalSkillPackage(args: {
  tenantId: string;
  versionId: string;
  db?: Db;
}) {
  const db = args.db ?? createServerSupabase();
  const loaded = await loadSkillVersionContext({
    tenantId: args.tenantId,
    versionId: args.versionId,
    db,
  });
  const sourceVersionId = String(
    loaded.snapshot.source_document_version_id ?? "",
  );
  if (!sourceVersionId) throw new Error("Original source archive unavailable.");
  return {
    bytes: await documentVersionBytes(sourceVersionId, db),
    filename: String(loaded.snapshot.source_filename ?? "skill-original.zip"),
  };
}

export async function buildMikeSkillPackage(args: {
  tenantId: string;
  versionId: string;
  db?: Db;
}) {
  const db = args.db ?? createServerSupabase();
  const loaded = await loadSkillVersionContext({
    tenantId: args.tenantId,
    versionId: args.versionId,
    db,
  });
  const manifest = (loaded.version.adapted_manifest ??
    loaded.snapshot.manifest) as {
    files?: Array<Record<string, unknown>>;
    licence_paths?: string[];
  };
  const files = [...(manifest.files ?? [])].sort((a, b) =>
    String(a.path).localeCompare(String(b.path), "en"),
  );
  // The Mike manifest must state the exact dependency versions this version is
  // bound to, not just its own provenance and mappings. That means the whole
  // resolved closure: direct edges alone would leave a transitive dependency's
  // version unpinned in the downloaded package.
  const dependencies = await resolvedDependencyBindings(
    args.versionId,
    db,
    args.tenantId,
  );
  // `required` is a property of a direct edge, so it is reported only where
  // one exists. Everything else in the closure is reached through those edges
  // and is present in the package regardless.
  const directRequired = new Map(
    (await dependencyBindings(args.versionId, db, args.tenantId)).map(
      (dependency) => [dependency.versionId, dependency.required],
    ),
  );
  const zip = new JSZip();
  const stableDate = new Date("1980-01-01T00:00:00.000Z");
  for (const file of files) {
    const bytes = await documentVersionBytes(
      String(file.document_version_id),
      db,
    );
    zip.file(String(file.path), Buffer.from(bytes), {
      binary: true,
      date: stableDate,
      createFolders: true,
    });
  }
  const mikeManifest = {
    schemaVersion: 1,
    skill: {
      id: String(loaded.skill.id),
      name: String(loaded.skill.canonical_name),
      displayName: String(loaded.skill.display_name),
      versionId: String(loaded.version.id),
      declaredVersion: loaded.version.declared_version ?? null,
      entrypoint: String(loaded.version.entrypoint_path),
      contentHash: String(
        loaded.version.adapted_content_hash ??
          loaded.version.original_content_hash,
      ),
      state: String(loaded.version.state),
    },
    provenance: {
      sourceKind: String(loaded.snapshot.source_kind),
      sourceFilename: loaded.snapshot.source_filename ?? null,
      treeHash: String(loaded.snapshot.tree_hash),
      snapshotId: String(loaded.snapshot.id),
      adapted: !!loaded.version.adapted_manifest,
      originalTreeHash: String(loaded.snapshot.tree_hash),
      activeTreeHash: String(
        (manifest as { tree_hash?: unknown }).tree_hash ??
          loaded.snapshot.tree_hash,
      ),
    },
    files: files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
      mediaType: file.media_type,
    })),
    licencePaths: manifest.licence_paths ?? [],
    dependencies: dependencies.map((dependency) => ({
      skillId: dependency.skillId,
      name: dependency.canonicalName,
      displayName: dependency.displayName,
      versionId: dependency.versionId,
      contentHash: dependency.contentHash,
      required: directRequired.get(dependency.versionId) ?? true,
      approvedExecutionContract: dependency.executionContract,
    })),
    approvedExecutionContract:
      loaded.version.approved_execution_contract ?? {},
  };
  zip.file(
    ".mike/skill-manifest.json",
    `${JSON.stringify(mikeManifest, null, 2)}\n`,
    { date: stableDate, createFolders: true },
  );
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  return {
    bytes: exactArrayBuffer(bytes),
    filename: `${String(loaded.skill.canonical_name)}-mike.zip`,
  };
}

export async function buildDeveloperSkillPackage(args: {
  tenantId: string;
  versionId: string;
  db?: Db;
}) {
  const db = args.db ?? createServerSupabase();
  const loaded = await loadSkillVersionContext({
    tenantId: args.tenantId,
    versionId: args.versionId,
    db,
  });
  const artifacts = await db
    .from("altien_skill_developer_artifacts")
    .select("*")
    .eq("tenant_id", args.tenantId)
    .eq("version_id", args.versionId)
    .eq("state", "approved")
    .order("created_at", { ascending: true });
  throwOnDbError(artifacts);
  if (!(artifacts.data ?? []).length) {
    throw new Error("No clean-room developer artifacts are available.");
  }
  const zip = new JSZip();
  const stableDate = new Date("1980-01-01T00:00:00.000Z");
  const artifactManifest = [];
  for (const [index, artifact] of (artifacts.data ?? []).entries()) {
    const filename = `${String(index + 1).padStart(2, "0")}-${safePackageSegment(String(artifact.requirement_name))}.md`;
    const bytes = await documentVersionBytes(
      String(artifact.document_version_id),
      db,
    );
    zip.file(`specifications/${filename}`, Buffer.from(bytes), {
      binary: true,
      date: stableDate,
      createFolders: true,
    });
    artifactManifest.push({
      id: artifact.id,
      requirementName: artifact.requirement_name,
      state: artifact.state,
      filename: `specifications/${filename}`,
      sourceHashes: artifact.source_hashes,
      generatorProvenance: artifact.generator_provenance,
      leakageCheck: artifact.leakage_check,
    });
  }
  const manifest = (loaded.version.adapted_manifest ??
    loaded.snapshot.manifest) as {
    files?: Array<Record<string, unknown>>;
    licence_paths?: string[];
  };
  for (const licencePath of manifest.licence_paths ?? []) {
    const file = (manifest.files ?? []).find(
      (candidate) => String(candidate.path) === licencePath,
    );
    if (!file?.document_version_id) continue;
    const bytes = await documentVersionBytes(
      String(file.document_version_id),
      db,
    );
    zip.file(`licences/${licencePath}`, Buffer.from(bytes), {
      binary: true,
      date: stableDate,
      createFolders: true,
    });
  }
  zip.file(
    "developer-package.json",
    `${JSON.stringify(
      {
        schemaVersion: 1,
        notice:
          "Human review required. These are clean-room behavioural drafts, not implementations.",
        skill: {
          id: loaded.skill.id,
          name: loaded.skill.canonical_name,
          versionId: loaded.version.id,
          contentHash:
            loaded.version.adapted_content_hash ??
            loaded.version.original_content_hash,
        },
        provenance: {
          snapshotId: loaded.snapshot.id,
          sourceKind: loaded.snapshot.source_kind,
          repository: loaded.snapshot.github_repository ?? null,
          commitSha: loaded.snapshot.github_resolved_commit_sha ?? null,
        },
        licencePaths: manifest.licence_paths ?? [],
        artifacts: artifactManifest,
      },
      null,
      2,
    )}\n`,
    { date: stableDate, createFolders: true },
  );
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  return {
    bytes: exactArrayBuffer(bytes),
    filename: `${String(loaded.skill.canonical_name)}-developer.zip`,
  };
}
