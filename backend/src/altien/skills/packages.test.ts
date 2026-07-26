import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { makeFakeDb } from "../../test/helpers/fakeDb";

const { downloadFileMock } = vi.hoisted(() => ({
  downloadFileMock: vi.fn(),
}));

vi.mock("../../lib/storage", () => ({
  downloadFile: downloadFileMock,
}));

import {
  buildMikeSkillPackage,
  buildOriginalSkillPackage,
  getSkillPackageInfo,
} from "./packages";

/**
 * `version-1` depends on `version-2`, which itself depends on `version-3`, so
 * the manifest has a transitive dependency to pin as well as a direct one.
 */
const DEPENDENCY_EDGES: Record<
  string,
  Array<{ skillId: string; versionId: string; required: boolean }>
> = {
  "version-1": [
    { skillId: "skill-2", versionId: "version-2", required: true },
  ],
  "version-2": [
    { skillId: "skill-3", versionId: "version-3", required: true },
  ],
};

const DEPENDENCY_VERSIONS: Record<string, Record<string, unknown>> = {
  "version-2": {
    id: "version-2",
    skill_id: "skill-2",
    state: "enabled",
    original_content_hash: "dependency-hash",
    approved_execution_contract: { projectRead: true },
  },
  "version-3": {
    id: "version-3",
    skill_id: "skill-3",
    state: "enabled",
    original_content_hash: "transitive-hash",
    approved_execution_contract: { approvedToolNames: ["find_in_document"] },
  },
};

const DEPENDENCY_SKILLS: Record<string, Record<string, unknown>> = {
  "skill-2": { id: "skill-2", canonical_name: "helper", display_name: "Helper" },
  "skill-3": { id: "skill-3", canonical_name: "deep", display_name: "Deep" },
};

function packageDb(adapted = false, withDependency = false) {
  return makeFakeDb((call) => {
    if (call.table === "altien_skill_dependencies") {
      const versionId = String(
        call.filters.find((filter) => filter[1] === "version_id")?.[2] ?? "",
      );
      return {
        data: withDependency
          ? (DEPENDENCY_EDGES[versionId] ?? []).map((edge) => ({
              version_id: versionId,
              dependency_skill_id: edge.skillId,
              dependency_version_id: edge.versionId,
              required: edge.required,
            }))
          : [],
        error: null,
      };
    }
    const requestedId = String(
      call.filters.find((filter) => filter[1] === "id")?.[2] ?? "",
    );
    if (
      withDependency &&
      call.table === "altien_skill_versions" &&
      DEPENDENCY_VERSIONS[requestedId]
    ) {
      return { data: [DEPENDENCY_VERSIONS[requestedId]], error: null };
    }
    if (
      withDependency &&
      call.table === "altien_skills" &&
      DEPENDENCY_SKILLS[requestedId]
    ) {
      return { data: [DEPENDENCY_SKILLS[requestedId]], error: null };
    }
    if (call.table === "altien_skill_versions") {
      return {
        data: [
          {
            id: "version-1",
            skill_id: "skill-1",
            snapshot_id: "snapshot-1",
            entrypoint_path: "reader/SKILL.md",
            original_content_hash: "content-hash",
            state: "enabled",
            declared_version: "1.0",
            approved_execution_contract: { projectRead: true },
            ...(adapted
              ? {
                  entrypoint_path: "renamed/SKILL.md",
                  adapted_content_hash: "adapted-content-hash",
                  adapted_manifest: {
                    tree_hash: "adapted-tree-hash",
                    licence_paths: ["renamed/LICENSE"],
                    files: [
                      {
                        path: "renamed/SKILL.md",
                        document_version_id: "adapted-skill-version",
                        sha256: "adapted-skill-hash",
                        bytes: 12,
                        media_type: "text/plain",
                      },
                      {
                        path: "renamed/LICENSE",
                        document_version_id: "adapted-licence-version",
                        sha256: "adapted-licence-hash",
                        bytes: 7,
                        media_type: "text/plain",
                      },
                    ],
                  },
                }
              : {}),
          },
        ],
        error: null,
      };
    }
    if (call.table === "altien_skills") {
      return {
        data: [
          {
            id: "skill-1",
            canonical_name: "reader",
            display_name: "Reader",
          },
        ],
        error: null,
      };
    }
    if (call.table === "altien_skill_import_snapshots") {
      return {
        data: [
          {
            id: "snapshot-1",
            source_kind: "zip",
            source_filename: "original.zip",
            source_document_version_id: "source-version",
            tree_hash: "tree-hash",
            manifest: {
              licence_paths: ["reader/LICENSE"],
              files: [
                {
                  path: "reader/SKILL.md",
                  document_version_id: "skill-version",
                  sha256: "skill-hash",
                  bytes: 10,
                  media_type: "text/plain",
                },
                {
                  path: "reader/LICENSE",
                  document_version_id: "licence-version",
                  sha256: "licence-hash",
                  bytes: 7,
                  media_type: "text/plain",
                },
              ],
            },
          },
        ],
        error: null,
      };
    }
    if (call.table === "document_versions") {
      const id = String(call.filters[0]?.[2]);
      return { data: [{ storage_path: `blob/${id}` }], error: null };
    }
    return { data: [], error: null };
  });
}

describe("skill packages", () => {
  it("returns the untouched original archive bytes", async () => {
    downloadFileMock.mockImplementation(async (path: string) =>
      path === "blob/source-version"
        ? new Uint8Array([1, 2, 3]).buffer
        : null,
    );
    const result = await buildOriginalSkillPackage({
      tenantId: "tenant-1",
      versionId: "version-1",
      db: packageDb().db as never,
    });
    expect(result.filename).toBe("original.zip");
    expect([...new Uint8Array(result.bytes)]).toEqual([1, 2, 3]);
  });

  it("builds a reproducible Mike package with provenance and licences", async () => {
    downloadFileMock.mockImplementation(async (path: string) =>
      new TextEncoder().encode(
        path.includes("skill-version") ? "skill text" : "licence",
      ).buffer,
    );
    const build = () =>
      buildMikeSkillPackage({
        tenantId: "tenant-1",
        versionId: "version-1",
        db: packageDb().db as never,
      });
    const first = await build();
    const second = await build();
    expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
    const zip = await JSZip.loadAsync(first.bytes);
    expect(Object.keys(zip.files)).toEqual(
      expect.arrayContaining([
        "reader/SKILL.md",
        "reader/LICENSE",
        ".mike/skill-manifest.json",
      ]),
    );
    const manifest = JSON.parse(
      await zip.file(".mike/skill-manifest.json")!.async("text"),
    );
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      skill: { versionId: "version-1", entrypoint: "reader/SKILL.md" },
      provenance: { sourceKind: "zip", treeHash: "tree-hash" },
      licencePaths: ["reader/LICENSE"],
    });
  });

  // A manifest that listed only the direct edges would leave the transitive
  // dependency's version unpinned in the downloaded package.
  it("pins the whole resolved dependency closure in the Mike manifest", async () => {
    downloadFileMock.mockImplementation(async () =>
      new TextEncoder().encode("skill text").buffer,
    );
    const fake = packageDb(false, true);
    const mike = await buildMikeSkillPackage({
      tenantId: "tenant-1",
      versionId: "version-1",
      db: fake.db as never,
    });
    const zip = await JSZip.loadAsync(mike.bytes);
    const manifest = JSON.parse(
      await zip.file(".mike/skill-manifest.json")!.async("text"),
    );
    expect(manifest.dependencies).toEqual([
      {
        skillId: "skill-3",
        name: "deep",
        displayName: "Deep",
        versionId: "version-3",
        contentHash: "transitive-hash",
        required: true,
        approvedExecutionContract: { approvedToolNames: ["find_in_document"] },
      },
      {
        skillId: "skill-2",
        name: "helper",
        displayName: "Helper",
        versionId: "version-2",
        contentHash: "dependency-hash",
        required: true,
        approvedExecutionContract: { projectRead: true },
      },
    ]);
    // Defence in depth: the owning-skill read is tenant-scoped.
    expect(
      fake
        .callsFor("altien_skills", "select")
        .filter((call) =>
          call.filters.some(
            (filter) => filter[1] === "tenant_id" && filter[2] === "tenant-1",
          ),
        ).length,
    ).toBeGreaterThan(0);
  });

  it("informs the downloader about licence files before download", async () => {
    await expect(
      getSkillPackageInfo({
        tenantId: "tenant-1",
        versionId: "version-1",
        db: packageDb().db as never,
      }),
    ).resolves.toMatchObject({
      licencePaths: ["reader/LICENSE"],
      originalAvailable: true,
      mikePackageAvailable: true,
    });
  });

  it("uses the adapted DMS tree for Mike packages but preserves the original ZIP", async () => {
    downloadFileMock.mockImplementation(async (path: string) =>
      path === "blob/source-version"
        ? new Uint8Array([9, 8, 7]).buffer
        : new TextEncoder().encode("adapted").buffer,
    );
    const db = packageDb(true).db as never;
    const mike = await buildMikeSkillPackage({
      tenantId: "tenant-1",
      versionId: "version-1",
      db,
    });
    const zip = await JSZip.loadAsync(mike.bytes);
    expect(zip.file("renamed/SKILL.md")).not.toBeNull();
    expect(zip.file("reader/SKILL.md")).toBeNull();
    const manifest = JSON.parse(
      await zip.file(".mike/skill-manifest.json")!.async("text"),
    );
    expect(manifest).toMatchObject({
      skill: {
        entrypoint: "renamed/SKILL.md",
        contentHash: "adapted-content-hash",
      },
      provenance: {
        adapted: true,
        originalTreeHash: "tree-hash",
        activeTreeHash: "adapted-tree-hash",
      },
    });
    const original = await buildOriginalSkillPackage({
      tenantId: "tenant-1",
      versionId: "version-1",
      db,
    });
    expect([...new Uint8Array(original.bytes)]).toEqual([9, 8, 7]);
  });
});
