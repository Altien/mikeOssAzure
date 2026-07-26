import { describe, expect, it, vi } from "vitest";
import { makeFakeDb } from "../../test/helpers/fakeDb";

const { uploadFileMock, downloadFileMock, deleteFileMock } = vi.hoisted(() => ({
  uploadFileMock: vi.fn(),
  downloadFileMock: vi.fn(),
  deleteFileMock: vi.fn(),
}));

vi.mock("../../lib/storage", () => ({
  uploadFile: uploadFileMock,
  downloadFile: downloadFileMock,
  deleteFile: deleteFileMock,
}));

import { persistSkillRename } from "./artifacts";

describe("persistSkillRename", () => {
  it("forks an update draft without renaming the live skill", async () => {
    uploadFileMock.mockResolvedValue(undefined);
    downloadFileMock.mockResolvedValue(
      new TextEncoder().encode(
        "---\nname: Existing Skill\ndescription: Test\n---\nUse existing-skill.",
      ).buffer,
    );
    const fake = makeFakeDb((call) => {
      if (call.table === "altien_skill_versions" && call.op === "select") {
        return {
          data: [{
            id: "draft-version",
            skill_id: "live-skill",
            snapshot_id: "snapshot-1",
            entrypoint_path: "existing-skill/SKILL.md",
            state: "draft",
          }],
          error: null,
        };
      }
      if (call.table === "altien_skills" && call.op === "select") {
        const byId = call.filters.some(
          (filter) =>
            filter[0] === "eq" &&
            filter[1] === "id" &&
            filter[2] === "live-skill",
        );
        return byId
          ? {
              data: [{
                id: "live-skill",
                canonical_name: "existing-skill",
                display_name: "Existing Skill",
                description: "Test",
                current_version_id: "enabled-version",
              }],
              error: null,
            }
          : { data: [], error: null };
      }
      if (call.table === "altien_skill_import_snapshots") {
        return {
          data: [{
            id: "snapshot-1",
            tenant_id: "tenant-1",
            dms_project_id: "library-project",
            root_folder_id: "snapshot-root",
            manifest: {
              licence_paths: [],
              files: [{
                path: "existing-skill/SKILL.md",
                sha256: "old-hash",
                bytes: 70,
                media_type: "text/markdown",
                inspection_class: "text",
                document_id: "source-document",
                document_version_id: "source-version",
              }],
            },
          }],
          error: null,
        };
      }
      if (call.table === "document_versions" && call.op === "select") {
        return { data: [{ storage_path: "source/SKILL.md" }], error: null };
      }
      return { data: [], error: null };
    });

    const result = await persistSkillRename({
      tenantId: "tenant-1",
      versionId: "draft-version",
      newDisplayName: "Forked Skill",
      adaptedBy: "admin-1",
      db: fake.db as never,
    });

    expect(result).toMatchObject({
      forkedFromSkillId: "live-skill",
      canonicalName: "forked-skill",
    });
    const createdSkill = fake.callsFor("altien_skills", "insert")[0];
    expect(createdSkill.payload).toMatchObject({
      canonical_name: "forked-skill",
      display_name: "Forked Skill",
    });
    const movedVersion = fake.callsFor("altien_skill_versions", "update")[0];
    expect(movedVersion.payload).toMatchObject({
      skill_id: result.skillId,
      entrypoint_path: "forked-skill/SKILL.md",
    });
    expect(fake.callsFor("altien_skills", "update")).toHaveLength(0);
  });
});
