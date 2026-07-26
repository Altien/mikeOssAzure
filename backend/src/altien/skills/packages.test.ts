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

function packageDb() {
  return makeFakeDb((call) => {
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
});
