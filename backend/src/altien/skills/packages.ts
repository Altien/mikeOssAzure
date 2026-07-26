import JSZip from "jszip";
import { downloadFile } from "../../lib/storage";
import { createServerSupabase } from "../../lib/supabase";

type Db = ReturnType<typeof createServerSupabase>;

type PackageContext = {
  skill: Record<string, unknown>;
  version: Record<string, unknown>;
  snapshot: Record<string, unknown>;
};

async function context(
  tenantId: string,
  versionId: string,
  db: Db,
): Promise<PackageContext> {
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
  if (snapshot.error || !snapshot.data) {
    throw new Error("Skill snapshot not found.");
  }
  return {
    skill: skill.data as Record<string, unknown>,
    version: version.data as Record<string, unknown>,
    snapshot: snapshot.data as Record<string, unknown>,
  };
}

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
  const loaded = await context(args.tenantId, args.versionId, db);
  const manifest = loaded.snapshot.manifest as {
    licence_paths?: unknown[];
    files?: unknown[];
  };
  return {
    versionId: args.versionId,
    skillName: String(loaded.skill.display_name),
    state: String(loaded.version.state),
    originalAvailable: !!loaded.snapshot.source_document_version_id,
    mikePackageAvailable: true,
    licencePaths: Array.isArray(manifest.licence_paths)
      ? manifest.licence_paths.map(String)
      : [],
    fileCount: Array.isArray(manifest.files) ? manifest.files.length : 0,
    treeHash: String(loaded.snapshot.tree_hash),
  };
}

export async function buildOriginalSkillPackage(args: {
  tenantId: string;
  versionId: string;
  db?: Db;
}) {
  const db = args.db ?? createServerSupabase();
  const loaded = await context(args.tenantId, args.versionId, db);
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
  const loaded = await context(args.tenantId, args.versionId, db);
  const manifest = loaded.snapshot.manifest as {
    files?: Array<Record<string, unknown>>;
    licence_paths?: string[];
  };
  const files = [...(manifest.files ?? [])].sort((a, b) =>
    String(a.path).localeCompare(String(b.path), "en"),
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
      contentHash: String(loaded.version.original_content_hash),
      state: String(loaded.version.state),
    },
    provenance: {
      sourceKind: String(loaded.snapshot.source_kind),
      sourceFilename: loaded.snapshot.source_filename ?? null,
      treeHash: String(loaded.snapshot.tree_hash),
      snapshotId: String(loaded.snapshot.id),
    },
    files: files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
      mediaType: file.media_type,
    })),
    licencePaths: manifest.licence_paths ?? [],
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
    bytes: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
    filename: `${String(loaded.skill.canonical_name)}-mike.zip`,
  };
}
