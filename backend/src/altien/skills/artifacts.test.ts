import { describe, expect, it, vi } from "vitest";
import { makeFakeDb } from "../../test/helpers/fakeDb";

const {
  uploadFileMock,
  downloadFileMock,
  deleteFileMock,
  generateCleanRoomBriefMock,
  collectCleanRoomGitHubSourcesMock,
  getUserModelSettingsMock,
} = vi.hoisted(() => ({
  uploadFileMock: vi.fn(),
  downloadFileMock: vi.fn(),
  deleteFileMock: vi.fn(),
  generateCleanRoomBriefMock: vi.fn(),
  collectCleanRoomGitHubSourcesMock: vi.fn(),
  getUserModelSettingsMock: vi.fn(),
}));

vi.mock("../../lib/storage", () => ({
  uploadFile: uploadFileMock,
  downloadFile: downloadFileMock,
  deleteFile: deleteFileMock,
}));

vi.mock("../../lib/userSettings", () => ({
  getUserModelSettings: getUserModelSettingsMock,
}));

vi.mock("./cleanRoom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cleanRoom")>();
  // Defaults to the real gated collector so the gate tests below still
  // exercise it; a test that needs a *fetched* link overrides it per call.
  collectCleanRoomGitHubSourcesMock.mockImplementation(
    actual.collectCleanRoomGitHubSources,
  );
  return {
    ...actual,
    generateCleanRoomBrief: generateCleanRoomBriefMock,
    collectCleanRoomGitHubSources: collectCleanRoomGitHubSourcesMock,
  };
});

import {
  approveCleanRoomDeveloperArtifact,
  createCleanRoomDeveloperArtifact,
  getCleanRoomDeveloperArtifact,
  persistSkillRename,
} from "./artifacts";
import {
  CLEAN_ROOM_GENERATOR_RUN_WORDS,
  CLEAN_ROOM_SNAPSHOT_RUN_WORDS,
} from "./cleanRoom";

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

const hiddenSource = Array.from(
  { length: 80 },
  (_unused, index) => `hiddenToken${index}`,
).join(" ");

function developerArtifactDb(
  options: {
    documentsInsertFails?: boolean;
    remoteMcp?: { name: string; endpoint: string };
  } = {},
) {
  return makeFakeDb((call) => {
    if (
      options.documentsInsertFails &&
      call.table === "documents" &&
      call.op === "insert"
    ) {
      return { data: null, error: { message: "documents insert failed" } };
    }
    if (call.table === "altien_skill_versions" && call.op === "select") {
      return {
        data: [{
          id: "version-1",
          skill_id: "skill-1",
          snapshot_id: "snapshot-1",
          entrypoint_path: "tool/SKILL.md",
          state: "draft",
          generated_analysis: {
            capabilityRequirements: [
              { name: "lookup_records", kind: "first_party_tool" },
            ],
          },
        }],
        error: null,
      };
    }
    if (call.table === "altien_skills" && call.op === "select") {
      return {
        data: [{
          id: "skill-1",
          canonical_name: "tool",
          display_name: "Tool",
          description: "Looks things up",
        }],
        error: null,
      };
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
            ...(options.remoteMcp
              ? {
                  mcp_requirements: [
                    {
                      kind: "remote",
                      sourcePath: "tool/mcp.json",
                      name: options.remoteMcp.name,
                      endpoint: options.remoteMcp.endpoint,
                      transport: "http",
                      auth: null,
                    },
                  ],
                }
              : {}),
            files: [
              {
                path: "tool/reviewed.ts",
                sha256: "reviewed-hash",
                bytes: 10,
                media_type: "text/plain",
                inspection_class: "source",
                document_id: "reviewed-document",
                document_version_id: "reviewed-version",
              },
              {
                path: "tool/unreviewed.ts",
                sha256: "unreviewed-hash",
                bytes: 10,
                media_type: "text/plain",
                inspection_class: "source",
                document_id: "unreviewed-document",
                document_version_id: "unreviewed-version",
              },
            ],
          },
        }],
        error: null,
      };
    }
    if (call.table === "document_versions" && call.op === "select") {
      return {
        data: [{ storage_path: `blob/${String(call.filters[0]?.[2])}` }],
        error: null,
      };
    }
    return { data: [], error: null };
  });
}

describe("clean-room brief eligibility", () => {
  it("refuses to specify a third party's hosted MCP", async () => {
    // Spec: a skill referencing an existing remote MCP requires that MCP; it
    // is not reverse-engineered. Writing its contract would be exactly that.
    const fake = developerArtifactDb({
      remoteMcp: {
        name: "citecheck_review",
        endpoint: "https://app.example.com/mcp",
      },
    });
    await expect(
      createCleanRoomDeveloperArtifact({
        tenantId: "tenant-1",
        versionId: "version-1",
        requirementName: "citecheck_review",
        createdBy: "admin-1",
        db: fake.db as never,
      }),
    ).rejects.toMatchObject({
      code: "remote_mcp_requirement",
      message: expect.stringContaining("https://app.example.com/mcp"),
    });
  });

  it("names the requirements it can specify when given an unknown one", async () => {
    const fake = developerArtifactDb();
    await expect(
      createCleanRoomDeveloperArtifact({
        tenantId: "tenant-1",
        versionId: "version-1",
        requirementName: "https://app.example.com/mcp",
        createdBy: "admin-1",
        db: fake.db as never,
      }),
    ).rejects.toMatchObject({
      code: "requirement_not_identified",
      message: expect.stringContaining("lookup_records"),
    });
  });
});

describe("createCleanRoomDeveloperArtifact", () => {
  it("blocks an artifact whose brief leaks a verbatim span of the snapshot", async () => {
    uploadFileMock.mockReset();
    deleteFileMock.mockReset();
    uploadFileMock.mockResolvedValue(undefined);
    downloadFileMock.mockImplementation(async (path: string) =>
      new TextEncoder().encode(
        path === "blob/unreviewed-version"
          ? hiddenSource
          : "the reviewed helper reads a query and returns records",
      ).buffer,
    );
    getUserModelSettingsMock.mockResolvedValue({
      fast_model: "gpt-5.4-lite",
      api_keys: {},
    });
    const leaked = Array.from(
      { length: CLEAN_ROOM_SNAPSHOT_RUN_WORDS + 2 },
      (_unused, index) => `hiddenToken${index}`,
    ).join(" ");
    generateCleanRoomBriefMock.mockResolvedValue({
      markdown: `# Brief\n\n${leaked}\n`,
      provenance: {
        provider: "openai",
        model: "gpt-5.4-lite",
        schemaVersion: 1,
      },
    });
    const fake = developerArtifactDb();

    const result = await createCleanRoomDeveloperArtifact({
      tenantId: "tenant-1",
      versionId: "version-1",
      requirementName: "lookup_records",
      sourcePaths: ["tool/reviewed.ts"],
      createdBy: "admin-1",
      db: fake.db as never,
    });

    expect(result.state).toBe("blocked");
    expect(result.leakageCheck).toMatchObject({
      passed: false,
      runWords: CLEAN_ROOM_SNAPSHOT_RUN_WORDS,
      violations: [expect.objectContaining({ path: "tool/unreviewed.ts" })],
    });
    expect(
      fake.callsFor("altien_skill_developer_artifacts", "insert")[0].payload,
    ).toMatchObject({ state: "blocked" });
  });

  it("records a passing leakage check for a behavioural brief", async () => {
    uploadFileMock.mockReset();
    uploadFileMock.mockResolvedValue(undefined);
    downloadFileMock.mockImplementation(async (path: string) =>
      new TextEncoder().encode(
        path === "blob/unreviewed-version"
          ? hiddenSource
          : "the reviewed helper reads a query and returns records",
      ).buffer,
    );
    getUserModelSettingsMock.mockResolvedValue({
      fast_model: "gpt-5.4-lite",
      api_keys: {},
    });
    generateCleanRoomBriefMock.mockResolvedValue({
      markdown: "# Brief\n\nAccepts a query and returns bounded records.\n",
      provenance: {
        provider: "openai",
        model: "gpt-5.4-lite",
        schemaVersion: 1,
      },
    });
    const fake = developerArtifactDb();

    const result = await createCleanRoomDeveloperArtifact({
      tenantId: "tenant-1",
      versionId: "version-1",
      requirementName: "lookup_records",
      sourcePaths: ["tool/reviewed.ts"],
      createdBy: "admin-1",
      db: fake.db as never,
    });

    expect(result.state).toBe("draft");
    expect(result.leakageCheck.passed).toBe(true);
    expect(result.reviewPayloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  // Spec: clean-room analysis may follow explicit github.com links through the
  // gated acquisition service. With the gate closed the brief is still
  // produced, and the skip is recorded in the artifact's provenance rather
  // than failing or being silently dropped.
  it("records a skipped GitHub source link when acquisition is gated off", async () => {
    delete process.env.ALLOW_GITHUB_SKILL_IMPORTS;
    uploadFileMock.mockReset();
    uploadFileMock.mockResolvedValue(undefined);
    downloadFileMock.mockImplementation(async (path: string) =>
      new TextEncoder().encode(
        path === "blob/unreviewed-version"
          ? hiddenSource
          : "ported from https://github.com/example/upstream/tree/main/tools",
      ).buffer,
    );
    getUserModelSettingsMock.mockResolvedValue({
      fast_model: "gpt-5.4-lite",
      api_keys: {},
    });
    generateCleanRoomBriefMock.mockResolvedValue({
      markdown: "# Brief\n\nAccepts a query and returns bounded records.\n",
      provenance: { provider: "openai", model: "gpt-5.4-lite", schemaVersion: 1 },
    });
    const fake = developerArtifactDb();

    const result = await createCleanRoomDeveloperArtifact({
      tenantId: "tenant-1",
      versionId: "version-1",
      requirementName: "lookup_records",
      sourcePaths: ["tool/reviewed.ts"],
      createdBy: "admin-1",
      db: fake.db as never,
    });

    expect(result.state).toBe("draft");
    expect(result.generatorProvenance).toMatchObject({
      linkedGitHubSources: [
        {
          url: "https://github.com/example/upstream/tree/main/tools",
          status: "skipped_gate_denied",
        },
      ],
    });
    expect(
      fake.callsFor("altien_skill_developer_artifacts", "insert")[0].payload,
    ).toMatchObject({
      generator_provenance: {
        linkedGitHubSources: [{ status: "skipped_gate_denied" }],
      },
    });
  });

  // Linked upstream text was never shown to the generator, so it is held to
  // the strict generator-level bar rather than the looser whole-snapshot one:
  // a short verbatim run of a third-party repository is already a leak.
  it("blocks a brief that reproduces a short verbatim run of a fetched link", async () => {
    uploadFileMock.mockReset();
    uploadFileMock.mockResolvedValue(undefined);
    downloadFileMock.mockImplementation(async () =>
      new TextEncoder().encode("the reviewed helper reads a query").buffer,
    );
    getUserModelSettingsMock.mockResolvedValue({
      fast_model: "gpt-5.4-lite",
      api_keys: {},
    });
    const upstreamRun = Array.from(
      { length: CLEAN_ROOM_GENERATOR_RUN_WORDS + 1 },
      (_unused, index) => `upstreamToken${index}`,
    ).join(" ");
    collectCleanRoomGitHubSourcesMock.mockResolvedValueOnce({
      sources: [
        {
          path: "github.com/example/upstream@abc/tools/index.ts",
          sha256: "upstream-hash",
          text: upstreamRun,
        },
      ],
      notes: [
        {
          url: "https://github.com/example/upstream/tree/main/tools",
          status: "fetched",
        },
      ],
    });
    generateCleanRoomBriefMock.mockResolvedValue({
      markdown: `# Brief\n\n${upstreamRun}\n`,
      provenance: { provider: "openai", model: "gpt-5.4-lite", schemaVersion: 1 },
    });
    const fake = developerArtifactDb();

    const result = await createCleanRoomDeveloperArtifact({
      tenantId: "tenant-1",
      versionId: "version-1",
      requirementName: "lookup_records",
      sourcePaths: ["tool/reviewed.ts"],
      createdBy: "admin-1",
      db: fake.db as never,
    });

    expect(result.state).toBe("blocked");
    expect(result.leakageCheck.violations).toEqual([
      expect.objectContaining({
        path: "github.com/example/upstream@abc/tools/index.ts",
        words: CLEAN_ROOM_GENERATOR_RUN_WORDS,
      }),
    ]);
    expect(result.leakageCheck.checkedPaths).toContain(
      "github.com/example/upstream@abc/tools/index.ts",
    );
  });

  it("leaves no DMS rows behind when the tree cannot be written", async () => {
    uploadFileMock.mockReset();
    deleteFileMock.mockReset();
    uploadFileMock.mockResolvedValue(undefined);
    deleteFileMock.mockResolvedValue(undefined);
    downloadFileMock.mockImplementation(async () =>
      new TextEncoder().encode("the reviewed helper reads a query").buffer,
    );
    getUserModelSettingsMock.mockResolvedValue({
      fast_model: "gpt-5.4-lite",
      api_keys: {},
    });
    generateCleanRoomBriefMock.mockResolvedValue({
      markdown: "# Brief\n\nAccepts a query.\n",
      provenance: {
        provider: "openai",
        model: "gpt-5.4-lite",
        schemaVersion: 1,
      },
    });
    const fake = developerArtifactDb({ documentsInsertFails: true });

    await expect(
      createCleanRoomDeveloperArtifact({
        tenantId: "tenant-1",
        versionId: "version-1",
        requirementName: "lookup_records",
        sourcePaths: ["tool/reviewed.ts"],
        createdBy: "admin-1",
        db: fake.db as never,
      }),
    ).rejects.toThrow("documents insert failed");

    expect(fake.callsFor("project_subfolders", "delete")).toHaveLength(1);
    expect(deleteFileMock).toHaveBeenCalledTimes(1);
    expect(
      fake.callsFor("altien_skill_developer_artifacts", "insert"),
    ).toHaveLength(0);
  });
});

describe("approveCleanRoomDeveloperArtifact", () => {
  const artifactRow = {
    id: "artifact-1",
    tenant_id: "tenant-1",
    version_id: "version-1",
    requirement_name: "lookup_records",
    document_id: "artifact-document",
    document_version_id: "artifact-version",
    source_hashes: [{ path: "tool/reviewed.ts", sha256: "reviewed-hash" }],
    generator_provenance: { provider: "openai", model: "gpt-5.4-lite" },
    leakage_check: { passed: true, runWords: 40, violations: [] },
    state: "draft",
  };

  function approvalDb(row: Record<string, unknown> = artifactRow) {
    return makeFakeDb((call) => {
      if (call.table === "altien_skill_developer_artifacts") {
        return { data: [row], error: null };
      }
      if (call.table === "document_versions") {
        return {
          data: [{ storage_path: "blob/artifact", filename: "lookup.md" }],
          error: null,
        };
      }
      return { data: [], error: null };
    });
  }

  it("approves only the exact reviewed payload", async () => {
    downloadFileMock.mockResolvedValue(
      new TextEncoder().encode("# Brief").buffer,
    );
    const reviewed = await getCleanRoomDeveloperArtifact({
      tenantId: "tenant-1",
      artifactId: "artifact-1",
      db: approvalDb().db as never,
    });
    expect(reviewed.reviewPayloadHash).toMatch(/^[0-9a-f]{64}$/);

    await expect(
      approveCleanRoomDeveloperArtifact({
        tenantId: "tenant-1",
        artifactId: "artifact-1",
        approvedBy: "admin-1",
        reviewedPayloadHash: "0".repeat(64),
        db: approvalDb().db as never,
      }),
    ).rejects.toThrow("changed since it was reviewed");

    const fake = approvalDb();
    await expect(
      approveCleanRoomDeveloperArtifact({
        tenantId: "tenant-1",
        artifactId: "artifact-1",
        approvedBy: "admin-1",
        reviewedPayloadHash: reviewed.reviewPayloadHash,
        db: fake.db as never,
      }),
    ).resolves.toEqual({ id: "artifact-1", state: "approved" });
    expect(
      fake.callsFor("altien_skill_developer_artifacts", "update")[0].payload,
    ).toMatchObject({ state: "approved", approved_by: "admin-1" });
  });

  it("refuses to approve an artifact blocked by its leakage check", async () => {
    const blocked = {
      ...artifactRow,
      state: "blocked",
      leakage_check: {
        passed: false,
        runWords: 40,
        violations: [{ path: "tool/unreviewed.ts" }],
      },
    };
    downloadFileMock.mockResolvedValue(
      new TextEncoder().encode("# Brief").buffer,
    );
    const reviewed = await getCleanRoomDeveloperArtifact({
      tenantId: "tenant-1",
      artifactId: "artifact-1",
      db: approvalDb(blocked).db as never,
    });
    await expect(
      approveCleanRoomDeveloperArtifact({
        tenantId: "tenant-1",
        artifactId: "artifact-1",
        approvedBy: "admin-1",
        reviewedPayloadHash: reviewed.reviewPayloadHash,
        db: approvalDb(blocked).db as never,
      }),
    ).rejects.toThrow("A blocked developer artifact cannot be approved.");
  });
});
