import { describe, expect, it, vi } from "vitest";
import { makeFakeDb } from "../../test/helpers/fakeDb";
import type { ValidatedSkillSnapshot } from "./archive";

const { uploadFileMock, deleteFileMock } = vi.hoisted(() => ({
  uploadFileMock: vi.fn(),
  deleteFileMock: vi.fn(),
}));

vi.mock("../../lib/storage", () => ({
  uploadFile: uploadFileMock,
  deleteFile: deleteFileMock,
  normalizeDownloadFilename: (name: string) => name,
}));

import { listTenantSkills, storeSkillSnapshot } from "./persistence";

function snapshot(): ValidatedSkillSnapshot {
  const skillBytes = new TextEncoder().encode(
    "---\nname: Review Skill\ndescription: Reviews files\n---\nDo it.",
  );
  const guideBytes = new TextEncoder().encode("Guide");
  return {
    treeHash: "a".repeat(64),
    expandedBytes: skillBytes.byteLength + guideBytes.byteLength,
    licencePaths: [],
    warnings: [],
    files: [
      {
        relativePath: "review/SKILL.md",
        bytes: skillBytes,
        byteSize: skillBytes.byteLength,
        sha256: "b".repeat(64),
        mediaType: "text/plain; charset=utf-8",
        inspectionClass: "text",
      },
      {
        relativePath: "review/guide.md",
        bytes: guideBytes,
        byteSize: guideBytes.byteLength,
        sha256: "c".repeat(64),
        mediaType: "text/plain; charset=utf-8",
        inspectionClass: "text",
      },
    ],
    skills: [
      {
        entrypointPath: "review/SKILL.md",
        rootPath: "review",
        declaredName: "Review Skill",
        description: "Reviews files",
        frontmatter: {
          name: "Review Skill",
          description: "Reviews files",
        },
        frontmatterRaw: "name: Review Skill\ndescription: Reviews files",
        instructionMarkdown: "Do it.",
        licencePaths: [],
      },
    ],
  };
}

describe("storeSkillSnapshot", () => {
  it("stores source and tree files as DMS records and creates a draft", async () => {
    uploadFileMock.mockReset();
    deleteFileMock.mockReset();
    uploadFileMock.mockResolvedValue(undefined);
    const fake = makeFakeDb((call) => {
      if (call.table === "projects" && call.op === "select") {
        return { data: [{ id: "skill-project" }], error: null };
      }
      if (call.table === "altien_skills" && call.op === "select") {
        return { data: [], error: null };
      }
      return { data: [], error: null };
    });

    const result = await storeSkillSnapshot({
      tenantId: "tenant-1",
      importedBy: "admin-1",
      sourceFilename: "skills.zip",
      sourceBytes: new Uint8Array([1, 2, 3]),
      snapshot: snapshot(),
      db: fake.db as never,
    });

    expect(uploadFileMock).toHaveBeenCalledTimes(3);
    expect(result.projectId).toBe("skill-project");
    expect(result.skills).toMatchObject([
      {
        canonicalName: "review-skill",
        displayName: "Review Skill",
        version: { state: "draft", entrypointPath: "review/SKILL.md" },
      },
    ]);
    const documents = fake.callsFor("documents", "insert")[0];
    expect(documents.payload).toHaveLength(3);
    const versions = fake.callsFor("document_versions", "insert")[0];
    expect(versions.payload).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "skill_import",
          filename: "SKILL.md",
        }),
        expect.objectContaining({
          source: "skill_import",
          filename: "skills.zip",
        }),
      ]),
    );
    expect(
      fake.callsFor("altien_skill_import_snapshots", "insert"),
    ).toHaveLength(1);
    expect(fake.callsFor("altien_skill_versions", "insert")[0].payload).toEqual(
      expect.objectContaining({ state: "draft" }),
    );
  });

  it("removes already uploaded blobs and writes no rows when upload fails", async () => {
    uploadFileMock.mockReset();
    deleteFileMock.mockReset();
    uploadFileMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("storage down"));
    deleteFileMock.mockResolvedValue(undefined);
    const fake = makeFakeDb();

    await expect(
      storeSkillSnapshot({
        tenantId: "tenant-1",
        importedBy: "admin-1",
        sourceFilename: "skills.zip",
        sourceBytes: new Uint8Array([1, 2, 3]),
        snapshot: snapshot(),
        db: fake.db as never,
      }),
    ).rejects.toThrow("storage down");

    expect(deleteFileMock).toHaveBeenCalledTimes(1);
    expect(fake.calls).toEqual([]);
  });

  function priorSkillDb(priorVersions: Array<Record<string, unknown>>) {
    return makeFakeDb((call) => {
      if (call.table === "projects" && call.op === "select") {
        return { data: [{ id: "skill-project" }], error: null };
      }
      if (call.table === "altien_skills" && call.op === "select") {
        return {
          data: [{
            id: "existing-skill",
            canonical_name: "review-skill",
            display_name: "Review Skill",
          }],
          error: null,
        };
      }
      if (call.table === "altien_skill_versions" && call.op === "select") {
        return { data: priorVersions, error: null };
      }
      if (
        call.table === "altien_skill_import_snapshots" &&
        call.op === "select"
      ) {
        return {
          data: [{
            id: "prior-snapshot",
            source_kind: "zip",
            source_filename: "skills.zip",
            manifest: { entrypoints: ["review/SKILL.md"] },
          }],
          error: null,
        };
      }
      return { data: [], error: null };
    });
  }

  it("does not attach a frontmatter-name-only match to the prior skill", async () => {
    uploadFileMock.mockReset();
    deleteFileMock.mockReset();
    uploadFileMock.mockResolvedValue(undefined);
    const fake = priorSkillDb([
      {
        id: "prior-version",
        snapshot_id: "prior-snapshot",
        entrypoint_path: "other/SKILL.md",
        original_content_hash: "d".repeat(64),
      },
    ]);
    const result = await storeSkillSnapshot({
      tenantId: "tenant-1",
      importedBy: "admin-1",
      sourceFilename: "different.zip",
      sourceBytes: new Uint8Array([1, 2, 3]),
      snapshot: snapshot(),
      db: fake.db as never,
    });
    expect(result.skills[0]).toMatchObject({
      canonicalName: "review-skill-2",
      isUpdate: false,
      possibleMatch: {
        skillId: "existing-skill",
        canonicalName: "review-skill",
        matchedOn: "declared_name",
      },
    });
    expect(result.skills[0].id).not.toBe("existing-skill");
    expect(fake.callsFor("altien_skills", "insert")).toHaveLength(1);
    expect(
      fake.callsFor("altien_skill_versions", "insert")[0].payload,
    ).toMatchObject({
      deterministic_analysis: expect.objectContaining({
        identity: expect.objectContaining({
          matched_on: "declared_name",
          linked_prior_skill_id: null,
        }),
      }),
    });
  });

  it("reports a matching ZIP filename and entrypoint set as a possible match only", async () => {
    uploadFileMock.mockReset();
    deleteFileMock.mockReset();
    uploadFileMock.mockResolvedValue(undefined);
    const fake = priorSkillDb([
      {
        id: "prior-version",
        snapshot_id: "prior-snapshot",
        entrypoint_path: "review/SKILL.md",
        original_content_hash: "d".repeat(64),
      },
    ]);
    const result = await storeSkillSnapshot({
      tenantId: "tenant-1",
      importedBy: "admin-1",
      sourceFilename: "skills.zip",
      sourceBytes: new Uint8Array([1, 2, 3]),
      snapshot: snapshot(),
      db: fake.db as never,
    });
    expect(result.skills[0]).toMatchObject({
      isUpdate: false,
      possibleMatch: { skillId: "existing-skill", matchedOn: "zip_source" },
    });
    expect(fake.callsFor("altien_skills", "insert")).toHaveLength(1);
  });

  it("imports a matching content hash as a new immutable draft version", async () => {
    uploadFileMock.mockReset();
    deleteFileMock.mockReset();
    uploadFileMock.mockResolvedValue(undefined);
    const fake = priorSkillDb([
      {
        id: "prior-version",
        snapshot_id: "prior-snapshot",
        entrypoint_path: "review/SKILL.md",
        original_content_hash: "b".repeat(64),
      },
    ]);
    const result = await storeSkillSnapshot({
      tenantId: "tenant-1",
      importedBy: "admin-1",
      sourceFilename: "skills.zip",
      sourceBytes: new Uint8Array([1, 2, 3]),
      snapshot: snapshot(),
      db: fake.db as never,
    });
    expect(result.skills[0]).toMatchObject({
      id: "existing-skill",
      canonicalName: "review-skill",
      isUpdate: true,
      version: { state: "draft" },
    });
    expect(result.skills[0].possibleMatch).toBeUndefined();
    expect(fake.callsFor("altien_skills", "insert")).toHaveLength(0);
    expect(
      fake.callsFor("altien_skill_versions", "insert")[0].payload,
    ).toMatchObject({ skill_id: "existing-skill", state: "draft" });
  });

  it("imports the same GitHub repository entrypoint as a new version of the prior skill", async () => {
    uploadFileMock.mockReset();
    deleteFileMock.mockReset();
    uploadFileMock.mockResolvedValue(undefined);
    const fake = makeFakeDb((call) => {
      if (call.table === "projects" && call.op === "select") {
        return { data: [{ id: "skill-project" }], error: null };
      }
      if (call.table === "altien_skills" && call.op === "select") {
        return {
          data: [{
            id: "existing-skill",
            canonical_name: "review-skill",
            display_name: "Review Skill",
          }],
          error: null,
        };
      }
      if (call.table === "altien_skill_versions" && call.op === "select") {
        return {
          data: [{
            id: "prior-version",
            snapshot_id: "prior-snapshot",
            entrypoint_path: "review/SKILL.md",
            original_content_hash: "d".repeat(64),
          }],
          error: null,
        };
      }
      if (
        call.table === "altien_skill_import_snapshots" &&
        call.op === "select"
      ) {
        return {
          data: [{
            id: "prior-snapshot",
            source_kind: "github",
            github_repository: "github.com/example/skills",
            github_selected_path: "review",
          }],
          error: null,
        };
      }
      return { data: [], error: null };
    });
    const result = await storeSkillSnapshot({
      tenantId: "tenant-1",
      importedBy: "admin-1",
      sourceFilename: "skills.zip",
      sourceBytes: new Uint8Array([1, 2, 3]),
      snapshot: snapshot(),
      sourceKind: "github",
      github: {
        repository: "github.com/example/skills",
        selectedPath: "review",
        requestedRef: "main",
        resolvedCommitSha: "a".repeat(40),
      },
      db: fake.db as never,
    });
    expect(result.skills[0]).toMatchObject({
      id: "existing-skill",
      isUpdate: true,
    });
    expect(fake.callsFor("altien_skills", "insert")).toHaveLength(0);
  });
});

describe("listTenantSkills", () => {
  it("normalizes database rows and selects the current visible version", async () => {
    const fake = makeFakeDb((call) => {
      if (call.table === "altien_skills") {
        return {
          data: [
            {
              id: "skill-1",
              canonical_name: "review-skill",
              display_name: "Review Skill",
              description: "Reviews files",
              current_version_id: "version-2",
            },
          ],
          error: null,
        };
      }
      if (call.table === "altien_skill_versions") {
        return {
          data: [
            {
              id: "version-1",
              skill_id: "skill-1",
              state: "draft",
              entrypoint_path: "old/SKILL.md",
              declared_version: "1",
              original_content_hash: "old-hash",
            },
            {
              id: "version-2",
              skill_id: "skill-1",
              state: "enabled",
              entrypoint_path: "SKILL.md",
              declared_version: "2",
              original_content_hash: "new-hash",
            },
          ],
          error: null,
        };
      }
      return { data: [], error: null };
    });

    await expect(
      listTenantSkills(
        "tenant-1",
        { includeDrafts: false },
        fake.db as never,
      ),
    ).resolves.toEqual([
      {
        id: "skill-1",
        canonicalName: "review-skill",
        displayName: "Review Skill",
        description: "Reviews files",
        version: {
          id: "version-2",
          state: "enabled",
          analysisState: "pending",
          entrypointPath: "SKILL.md",
          declaredVersion: "2",
          contentHash: "new-hash",
          sourceKind: "zip",
        },
      },
    ]);
  });
});
