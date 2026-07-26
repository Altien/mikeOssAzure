import { beforeEach, describe, expect, it, vi } from "vitest";
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

import {
  deleteSkillDraftVersion,
  listTenantSkills,
  storeSkillSnapshot,
} from "./persistence";
import type { DbCall } from "../../test/helpers/fakeDb";

/** Value of the first filter on `column`, or undefined when unfiltered. */
function filterValue(call: DbCall, column: string) {
  return call.filters.find(([, name]) => name === column)?.[2];
}

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

  function priorSkillDb(
    priorVersions: Array<Record<string, unknown>>,
    options: { failVersionInsert?: boolean } = {},
  ) {
    return makeFakeDb((call) => {
      if (
        options.failVersionInsert &&
        call.table === "altien_skill_versions" &&
        call.op === "insert"
      ) {
        return { data: null, error: { message: "version insert failed" } };
      }
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
        // The duplicate-import guard asks for one exact content hash; the
        // identity check asks for every version of the candidate skill.
        const hash = filterValue(call, "original_content_hash");
        return {
          data:
            hash === undefined
              ? priorVersions
              : priorVersions.filter(
                  (row) => row.original_content_hash === hash,
                ),
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

  // `unique(skill_id, original_content_hash)` (migration 0027) rejects the
  // insert; without this guard the administrator sees a raw duplicate-key
  // error and the bad import is stuck in the library.
  it("refuses a re-import of content the skill already has", async () => {
    uploadFileMock.mockReset();
    deleteFileMock.mockReset();
    uploadFileMock.mockResolvedValue(undefined);
    deleteFileMock.mockResolvedValue(undefined);
    const fake = priorSkillDb([
      {
        id: "prior-version",
        snapshot_id: "prior-snapshot",
        entrypoint_path: "review/SKILL.md",
        original_content_hash: "b".repeat(64),
      },
    ]);

    await expect(
      storeSkillSnapshot({
        tenantId: "tenant-1",
        importedBy: "admin-1",
        sourceFilename: "skills.zip",
        sourceBytes: new Uint8Array([1, 2, 3]),
        snapshot: snapshot(),
        db: fake.db as never,
      }),
    ).rejects.toThrow("This exact version was already imported");

    expect(fake.callsFor("altien_skill_versions", "insert")).toHaveLength(0);
    // The refused import takes its own rows and blobs with it.
    expect(fake.callsFor("altien_skill_import_snapshots", "delete")).toHaveLength(
      1,
    );
    expect(deleteFileMock).toHaveBeenCalledTimes(3);
  });

  /** Prior skill linked by GitHub provenance, so its content hash differs. */
  function githubPriorSkillDb(options: { failVersionInsert?: boolean } = {}) {
    return makeFakeDb((call) => {
      if (
        options.failVersionInsert &&
        call.table === "altien_skill_versions" &&
        call.op === "insert"
      ) {
        return { data: null, error: { message: "version insert failed" } };
      }
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
        const priorVersions = [{
          id: "prior-version",
          snapshot_id: "prior-snapshot",
          entrypoint_path: "review/SKILL.md",
          original_content_hash: "d".repeat(64),
        }];
        const hash = filterValue(call, "original_content_hash");
        return {
          data:
            hash === undefined
              ? priorVersions
              : priorVersions.filter(
                  (row) => row.original_content_hash === hash,
                ),
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
  }

  const githubImport = {
    tenantId: "tenant-1",
    importedBy: "admin-1",
    sourceFilename: "skills.zip",
    sourceBytes: new Uint8Array([1, 2, 3]),
    sourceKind: "github" as const,
    github: {
      repository: "github.com/example/skills",
      selectedPath: "review",
      requestedRef: "main",
      resolvedCommitSha: "a".repeat(40),
    },
  };

  // A version added to a pre-existing skill is not cascaded away by deleting
  // the skills this import created — there are none. Without an explicit
  // delete, `altien_skill_versions.snapshot_id` (on delete restrict) makes the
  // snapshot and document deletes fail silently and orphan rows whose blobs
  // have already gone.
  it("deletes the version row it added to a pre-existing skill when the import fails", async () => {
    uploadFileMock.mockReset();
    deleteFileMock.mockReset();
    uploadFileMock.mockResolvedValue(undefined);
    deleteFileMock.mockResolvedValue(undefined);
    const fake = githubPriorSkillDb({ failVersionInsert: true });

    await expect(
      storeSkillSnapshot({
        ...githubImport,
        snapshot: snapshot(),
        db: fake.db as never,
      }),
    ).rejects.toThrow("version insert failed");

    expect(fake.callsFor("altien_skills", "delete")).toHaveLength(0);
    const versionDeletes = fake.callsFor("altien_skill_versions", "delete");
    expect(versionDeletes).toHaveLength(1);
    expect(versionDeletes[0].filters[0][1]).toBe("id");
    const order = (table: string, op: "delete") =>
      fake.calls.findIndex((call) => call.table === table && call.op === op);
    expect(order("altien_skill_versions", "delete")).toBeLessThan(
      order("altien_skill_import_snapshots", "delete"),
    );
    expect(order("altien_skill_import_snapshots", "delete")).toBeLessThan(
      order("documents", "delete"),
    );
    expect(deleteFileMock).toHaveBeenCalledTimes(3);
  });

  it("imports the same GitHub repository entrypoint as a new version of the prior skill", async () => {
    uploadFileMock.mockReset();
    deleteFileMock.mockReset();
    uploadFileMock.mockResolvedValue(undefined);
    const fake = githubPriorSkillDb();
    const result = await storeSkillSnapshot({
      ...githubImport,
      snapshot: snapshot(),
      db: fake.db as never,
    });
    expect(result.skills[0]).toMatchObject({
      id: "existing-skill",
      isUpdate: true,
      version: { state: "draft" },
    });
    expect(result.skills[0].possibleMatch).toBeUndefined();
    expect(fake.callsFor("altien_skills", "insert")).toHaveLength(0);
    expect(
      fake.callsFor("altien_skill_versions", "insert")[0].payload,
    ).toMatchObject({ skill_id: "existing-skill", state: "draft" });
  });
});

describe("deleteSkillDraftVersion", () => {
  const draftVersion = {
    id: "version-1",
    skill_id: "skill-1",
    snapshot_id: "snapshot-1",
    state: "draft",
    adapted_manifest: null,
    adapted_root_folder_id: null,
  };
  const parentSkill = {
    id: "skill-1",
    tenant_id: "tenant-1",
    current_version_id: null,
  };
  const importSnapshot = {
    id: "snapshot-1",
    tenant_id: "tenant-1",
    dms_project_id: "project-1",
    root_folder_id: "folder-1",
    source_document_id: "doc-source",
    manifest: {
      files: [{ document_id: "doc-1", document_version_id: "dv-1" }],
    },
  };

  function deleteDb(
    overrides: {
      version?: Record<string, unknown>;
      skill?: Record<string, unknown>;
      /** Rows returned for "every version of this skill". */
      skillVersions?: Array<Record<string, unknown>>;
      /** Rows returned for "every version cut from this snapshot". */
      snapshotVersions?: Array<Record<string, unknown>>;
      bindings?: Array<Record<string, unknown>>;
      dependents?: Array<Record<string, unknown>>;
      pins?: Array<Record<string, unknown>>;
      artifacts?: Array<Record<string, unknown>>;
    } = {},
  ) {
    return makeFakeDb((call) => {
      if (call.op !== "select") return { data: [], error: null };
      switch (call.table) {
        case "altien_skill_versions":
          if (filterValue(call, "id") !== undefined) {
            return {
              data: [{ ...draftVersion, ...overrides.version }],
              error: null,
            };
          }
          if (filterValue(call, "skill_id") !== undefined) {
            return {
              data: overrides.skillVersions ?? [{ id: "version-1" }],
              error: null,
            };
          }
          return {
            data: overrides.snapshotVersions ?? [{ id: "version-1" }],
            error: null,
          };
        case "altien_skills":
          return {
            data: [{ ...parentSkill, ...overrides.skill }],
            error: null,
          };
        case "altien_skill_import_snapshots":
          return { data: [importSnapshot], error: null };
        case "altien_chat_skill_bindings":
          return { data: overrides.bindings ?? [], error: null };
        case "altien_skill_dependencies":
          return { data: overrides.dependents ?? [], error: null };
        case "altien_project_skill_pins":
          return { data: overrides.pins ?? [], error: null };
        case "altien_skill_import_conversations":
          return { data: [{ id: "conversation-1" }], error: null };
        case "altien_skill_developer_artifacts":
          return { data: overrides.artifacts ?? [], error: null };
        case "document_versions":
          return {
            data: [
              {
                id: "dv-1",
                document_id: "doc-1",
                storage_path: "documents/library/doc-1/versions/dv-1.md",
              },
              {
                id: "dv-source",
                document_id: "doc-source",
                storage_path:
                  "documents/library/doc-source/versions/dv-source.zip",
              },
            ],
            error: null,
          };
        default:
          return { data: [], error: null };
      }
    });
  }

  const deleteOrder = (
    fake: ReturnType<typeof makeFakeDb>,
    table: string,
  ) => fake.calls.findIndex((c) => c.table === table && c.op === "delete");

  beforeEach(() => {
    deleteFileMock.mockReset();
    deleteFileMock.mockResolvedValue(undefined);
  });

  it("deletes a lone draft with its snapshot tree and parent skill", async () => {
    const fake = deleteDb();

    const result = await deleteSkillDraftVersion({
      tenantId: "tenant-1",
      versionId: "version-1",
      db: fake.db as never,
    });

    expect(result).toMatchObject({
      versionId: "version-1",
      skillId: "skill-1",
      skillDeleted: true,
      snapshotDeleted: true,
      deletedDocumentCount: 2,
      deletedBlobCount: 2,
    });
    // Review rows reference each other: actions -> messages -> conversation.
    expect(deleteOrder(fake, "altien_skill_pending_actions")).toBeLessThan(
      deleteOrder(fake, "altien_skill_import_messages"),
    );
    expect(deleteOrder(fake, "altien_skill_import_messages")).toBeLessThan(
      deleteOrder(fake, "altien_skill_import_conversations"),
    );
    // `snapshot_id` is on delete restrict, and the snapshot references its
    // source document, which lives in the preserved folder tree.
    expect(deleteOrder(fake, "altien_skill_import_conversations")).toBeLessThan(
      deleteOrder(fake, "altien_skill_versions"),
    );
    expect(deleteOrder(fake, "altien_skill_versions")).toBeLessThan(
      deleteOrder(fake, "altien_skills"),
    );
    expect(deleteOrder(fake, "altien_skills")).toBeLessThan(
      deleteOrder(fake, "altien_skill_import_snapshots"),
    );
    expect(deleteOrder(fake, "altien_skill_import_snapshots")).toBeLessThan(
      deleteOrder(fake, "documents"),
    );
    expect(deleteOrder(fake, "documents")).toBeLessThan(
      deleteOrder(fake, "project_subfolders"),
    );
    expect(fake.callsFor("documents", "delete")[0].filters[0]).toEqual([
      "in",
      "id",
      ["doc-1", "doc-source"],
    ]);
    expect(fake.callsFor("project_subfolders", "delete")[0].filters[0]).toEqual(
      ["eq", "id", "folder-1"],
    );
    // Blobs go last: no surviving row ever points at a deleted blob.
    expect(deleteFileMock.mock.calls.map(([path]) => path)).toEqual([
      "documents/library/doc-1/versions/dv-1.md",
      "documents/library/doc-source/versions/dv-source.zip",
    ]);
  });

  it("refuses a version that is no longer a draft", async () => {
    const fake = deleteDb({ version: { state: "enabled" } });

    await expect(
      deleteSkillDraftVersion({
        tenantId: "tenant-1",
        versionId: "version-1",
        db: fake.db as never,
      }),
    ).rejects.toThrow(/Only a draft version can be deleted; this version is enabled/);

    expect(fake.calls.filter((call) => call.op === "delete")).toEqual([]);
    expect(deleteFileMock).not.toHaveBeenCalled();
  });

  it("refuses a version a chat is bound to, as root or as a dependency", async () => {
    const asRoot = deleteDb({
      bindings: [
        {
          chat_id: "chat-1",
          root_version_id: "version-1",
          dependency_versions: [],
        },
      ],
    });
    await expect(
      deleteSkillDraftVersion({
        tenantId: "tenant-1",
        versionId: "version-1",
        db: asRoot.db as never,
      }),
    ).rejects.toThrow(/A chat is still bound to this skill version/);
    expect(asRoot.calls.filter((call) => call.op === "delete")).toEqual([]);

    const asDependency = deleteDb({
      bindings: [
        {
          chat_id: "chat-2",
          root_version_id: "version-other",
          dependency_versions: [{ versionId: "version-1" }],
        },
      ],
    });
    await expect(
      deleteSkillDraftVersion({
        tenantId: "tenant-1",
        versionId: "version-1",
        db: asDependency.db as never,
      }),
    ).rejects.toThrow(/A chat is still bound to this skill version/);
    expect(deleteFileMock).not.toHaveBeenCalled();
  });

  it("refuses a version another skill version depends on", async () => {
    const fake = deleteDb({
      dependents: [
        { version_id: "version-9", dependency_skill_id: "skill-9" },
      ],
    });

    await expect(
      deleteSkillDraftVersion({
        tenantId: "tenant-1",
        versionId: "version-1",
        db: fake.db as never,
      }),
    ).rejects.toThrow(/Another skill version depends on this version/);
    expect(fake.calls.filter((call) => call.op === "delete")).toEqual([]);
  });

  it("refuses a version a project pins", async () => {
    const fake = deleteDb({
      pins: [{ project_id: "project-1", skill_id: "skill-1" }],
    });

    await expect(
      deleteSkillDraftVersion({
        tenantId: "tenant-1",
        versionId: "version-1",
        db: fake.db as never,
      }),
    ).rejects.toThrow(/A project pins this skill version/);
    expect(fake.calls.filter((call) => call.op === "delete")).toEqual([]);
  });

  it("keeps the parent skill and the snapshot when another version remains", async () => {
    const fake = deleteDb({
      skillVersions: [{ id: "version-1" }, { id: "version-2" }],
      snapshotVersions: [{ id: "version-1" }, { id: "version-2" }],
    });

    const result = await deleteSkillDraftVersion({
      tenantId: "tenant-1",
      versionId: "version-1",
      db: fake.db as never,
    });

    expect(result).toMatchObject({
      skillDeleted: false,
      snapshotDeleted: false,
      deletedDocumentCount: 0,
      deletedBlobCount: 0,
    });
    expect(fake.callsFor("altien_skill_versions", "delete")).toHaveLength(1);
    expect(fake.callsFor("altien_skills", "delete")).toHaveLength(0);
    expect(
      fake.callsFor("altien_skill_import_snapshots", "delete"),
    ).toHaveLength(0);
    expect(fake.callsFor("documents", "delete")).toHaveLength(0);
    expect(fake.callsFor("project_subfolders", "delete")).toHaveLength(0);
    expect(deleteFileMock).not.toHaveBeenCalled();
  });

  it("removes developer artifacts and the adapted tree before the version row", async () => {
    const fake = deleteDb({
      version: {
        adapted_root_folder_id: "adapted-folder-1",
        adapted_manifest: {
          files: [
            { document_id: "doc-adapted", document_version_id: "dv-adapted" },
          ],
        },
      },
      artifacts: [{ id: "artifact-1", document_id: "doc-brief" }],
    });

    const result = await deleteSkillDraftVersion({
      tenantId: "tenant-1",
      versionId: "version-1",
      db: fake.db as never,
    });

    expect(result.deletedDocumentCount).toBe(4);
    expect(
      deleteOrder(fake, "altien_skill_developer_artifacts"),
    ).toBeLessThan(deleteOrder(fake, "documents"));
    expect(deleteOrder(fake, "documents")).toBeLessThan(
      deleteOrder(fake, "altien_skill_versions"),
    );
    // `adapted_root_folder_id` has no cascade, so the version row goes first.
    const folderDeletes = fake.callsFor("project_subfolders", "delete");
    expect(folderDeletes.map((call) => call.filters[0][2])).toEqual([
      "adapted-folder-1",
      "folder-1",
    ]);
    expect(deleteOrder(fake, "altien_skill_versions")).toBeLessThan(
      folderDeletes.length
        ? fake.calls.indexOf(folderDeletes[0])
        : Number.MAX_SAFE_INTEGER,
    );
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
