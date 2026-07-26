import { describe, expect, it, vi } from "vitest";
import { makeFakeDb } from "../../test/helpers/fakeDb";

const { downloadFileMock } = vi.hoisted(() => ({
  downloadFileMock: vi.fn(),
}));

vi.mock("../../lib/storage", () => ({
  downloadFile: downloadFileMock,
}));

import { analyseSkillVersion, postSkillReviewMessage } from "./review";
import { hashActionPayload } from "./actions";

const fastModelSettings = vi.fn().mockResolvedValue({
  fast_model: "gpt-5.4-lite",
  api_keys: {},
}) as never;

function reviewDb() {
  return makeFakeDb((call) => {
    if (call.table === "altien_skill_versions" && call.op === "select") {
      return {
        data: [
          {
            id: "version-1",
            skill_id: "skill-1",
            snapshot_id: "snapshot-1",
            entrypoint_path: "reader/SKILL.md",
            deterministic_analysis: { warnings: [] },
          },
        ],
        error: null,
      };
    }
    if (call.table === "altien_skills" && call.op === "select") {
      return {
        data: [
          {
            id: "skill-1",
            display_name: "Reader",
            description: "Reads documents",
          },
        ],
        error: null,
      };
    }
    if (
      call.table === "altien_skill_import_snapshots" &&
      call.op === "select"
    ) {
      return {
        data: [
          {
            id: "snapshot-1",
            manifest: {
              files: [
                {
                  path: "reader/SKILL.md",
                  document_version_id: "document-version-1",
                },
              ],
            },
          },
        ],
        error: null,
      };
    }
    if (call.table === "document_versions" && call.op === "select") {
      return { data: [{ storage_path: "skills/reader.md" }], error: null };
    }
    if (
      call.table === "altien_skill_import_conversations" &&
      call.op === "select"
    ) {
      return { data: [{ id: "conversation-1" }], error: null };
    }
    return { data: [], error: null };
  });
}

describe("analyseSkillVersion", () => {
  it("stores deterministic and generated analysis separately with provenance", async () => {
    downloadFileMock.mockResolvedValue(
      new TextEncoder().encode("Read the selected project documents.").buffer,
    );
    const fake = reviewDb();
    const analyse = vi.fn().mockResolvedValue({
      provider: "openai",
      model: "gpt-5.4-lite",
      schemaVersion: 1,
      inputHash: "input-hash",
      generated: {
        summary: "Reads project documents.",
        capabilityRequirements: [],
        risks: [],
        unresolvedReferences: [],
      },
    });

    const result = await analyseSkillVersion({
      tenantId: "tenant-1",
      versionId: "version-1",
      userId: "admin-1",
      db: fake.db as never,
      settings: vi.fn().mockResolvedValue({
        fast_model: "gpt-5.4-lite",
        api_keys: {},
      }) as never,
      analyse,
    });

    expect(result.artifact.inputHash).toBe("input-hash");
    expect(analyse).toHaveBeenCalledWith(
      expect.objectContaining({
        instructions: "Read the selected project documents.",
        deterministicFindings: { warnings: [] },
        model: "gpt-5.4-lite",
      }),
    );
    expect(
      fake.callsFor("altien_skill_versions", "update").map((call) => call.payload),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ analysis_state: "running" }),
        expect.objectContaining({
          analysis_state: "succeeded",
          analysis_provider: "openai",
          analysis_model: "gpt-5.4-lite",
          generated_analysis: expect.any(Object),
        }),
      ]),
    );
  });

  it("records failure and does not fabricate fallback analysis", async () => {
    downloadFileMock.mockResolvedValue(
      new TextEncoder().encode("Read documents.").buffer,
    );
    const fake = reviewDb();

    await expect(
      analyseSkillVersion({
        tenantId: "tenant-1",
        versionId: "version-1",
        userId: "admin-1",
        db: fake.db as never,
        settings: vi.fn().mockResolvedValue({
          fast_model: "gpt-5.4-lite",
          api_keys: {},
        }) as never,
        analyse: vi.fn().mockRejectedValue(new Error("provider unavailable")),
      }),
    ).rejects.toThrow("provider unavailable");

    expect(
      fake
        .callsFor("altien_skill_versions", "update")
        .map((call) => call.payload),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ analysis_state: "failed" }),
      ]),
    );
  });
});

const possibleMatch = {
  skillId: "existing-skill",
  canonicalName: "review-skill",
  displayName: "Review Skill",
  matchedOn: "declared_name",
};

function identityDb(options: {
  pending?: Record<string, unknown>;
}) {
  return makeFakeDb((call) => {
    if (call.table === "altien_skill_versions" && call.op === "select") {
      const bySkill = call.filters.some((filter) => filter[1] === "skill_id");
      if (bySkill) return { data: [], error: null };
      return {
        data: [
          {
            id: "version-1",
            skill_id: "placeholder-skill",
            snapshot_id: "snapshot-1",
            entrypoint_path: "reader/SKILL.md",
            original_content_hash: "content-hash",
            state: "draft",
            deterministic_analysis: {
              warnings: [],
              identity: {
                declared_canonical_name: "review-skill",
                matched_on: "declared_name",
                linked_prior_skill_id: null,
                possible_match: possibleMatch,
              },
            },
          },
        ],
        error: null,
      };
    }
    if (call.table === "altien_skills" && call.op === "select") {
      const prior = call.filters.some(
        (filter) => filter[1] === "id" && filter[2] === "existing-skill",
      );
      return {
        data: [
          prior
            ? {
                id: "existing-skill",
                canonical_name: "review-skill",
                display_name: "Review Skill",
              }
            : {
                id: "placeholder-skill",
                canonical_name: "review-skill-2",
                display_name: "Review Skill",
                description: "Reviews files",
              },
        ],
        error: null,
      };
    }
    if (call.table === "altien_skill_import_snapshots") {
      return { data: [{ id: "snapshot-1" }], error: null };
    }
    if (call.table === "altien_skill_import_conversations") {
      return { data: [{ id: "conversation-1" }], error: null };
    }
    if (call.table === "altien_skill_pending_actions" && call.op === "select") {
      const byActionType = call.filters.some(
        (filter) => filter[1] === "action_type",
      );
      if (byActionType) return { data: [], error: null };
      return { data: options.pending ? [options.pending] : [], error: null };
    }
    return { data: [], error: null };
  });
}

describe("import identity confirmation", () => {
  it("proposes an exact pending action instead of attaching a name-only match", async () => {
    const fake = identityDb({});
    const result = await postSkillReviewMessage({
      tenantId: "tenant-1",
      versionId: "version-1",
      userId: "admin-1",
      message: "What did you find?",
      db: fake.db as never,
    });
    expect(result).toMatchObject({
      outcome: "proposed",
      action: { actionType: "link_prior_skill" },
    });
    const inserted = fake.callsFor("altien_skill_pending_actions", "insert")[0];
    expect(inserted.payload).toMatchObject({
      action_type: "link_prior_skill",
      version_id: "version-1",
      payload: {
        currentSkillId: "placeholder-skill",
        priorSkillId: "existing-skill",
        matchedOn: "declared_name",
        contentHash: "content-hash",
      },
    });
    expect(fake.callsFor("altien_skill_versions", "update")).toHaveLength(0);
  });

  it("moves the draft onto the prior skill only after the exact payload is authorized", async () => {
    const payload = {
      versionId: "version-1",
      currentSkillId: "placeholder-skill",
      priorSkillId: "existing-skill",
      priorCanonicalName: "review-skill",
      matchedOn: "declared_name",
      contentHash: "content-hash",
    };
    const fake = identityDb({
      pending: {
        id: "action-1",
        version_id: "version-1",
        action_type: "link_prior_skill",
        payload,
        payload_hash: hashActionPayload(payload),
        state: "pending",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    const result = await postSkillReviewMessage({
      tenantId: "tenant-1",
      versionId: "version-1",
      userId: "admin-1",
      message: "yes",
      db: fake.db as never,
    });
    expect(result).toMatchObject({ outcome: "linked", actionId: "action-1" });
    expect(
      fake.callsFor("altien_skill_versions", "update")[0].payload,
    ).toEqual({ skill_id: "existing-skill" });
    expect(fake.callsFor("altien_skills", "delete")).toHaveLength(1);
    expect(
      fake.callsFor("altien_skill_pending_actions", "update")[0].payload,
    ).toMatchObject({ state: "executed" });
  });

  it("refuses an authorization whose payload no longer matches the import", async () => {
    const payload = {
      versionId: "version-1",
      currentSkillId: "placeholder-skill",
      priorSkillId: "existing-skill",
      priorCanonicalName: "review-skill",
      matchedOn: "declared_name",
      contentHash: "stale-hash",
    };
    const fake = identityDb({
      pending: {
        id: "action-1",
        version_id: "version-1",
        action_type: "link_prior_skill",
        payload,
        payload_hash: hashActionPayload(payload),
        state: "pending",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    await expect(
      postSkillReviewMessage({
        tenantId: "tenant-1",
        versionId: "version-1",
        userId: "admin-1",
        message: "yes",
        db: fake.db as never,
      }),
    ).rejects.toThrow("The pending action no longer matches this import.");
    expect(fake.callsFor("altien_skill_versions", "update")).toHaveLength(0);
  });
});

const PROJECT_BASELINE = [
  "list_documents",
  "fetch_documents",
  "read_document",
  "find_in_document",
];

const generatedAnalysis = {
  summary: "Reads project documents.",
  capabilityRequirements: [
    {
      name: "project documents",
      kind: "project_read",
      required: true,
      rationale: "Reads the selected project documents.",
    },
    {
      name: "appropriate tools",
      kind: "first_party_tool",
      required: false,
      rationale: "The skill names its tools vaguely.",
    },
  ],
  risks: [],
  unresolvedReferences: [],
};

function enableDb(
  options: {
    pending?: Record<string, unknown>;
    declaredMetadata?: Record<string, string>;
    acquisitions?: Array<Record<string, unknown>>;
  } = {},
) {
  return makeFakeDb((call) => {
    if (call.table === "altien_skill_versions" && call.op === "select") {
      return {
        data: [
          {
            id: "version-1",
            skill_id: "skill-1",
            snapshot_id: "snapshot-1",
            entrypoint_path: "reader/SKILL.md",
            state: "draft",
            analysis_state: "succeeded",
            analysis_input_hash: "analysis-hash",
            original_content_hash: "content-hash",
            declared_metadata: options.declaredMetadata ?? {},
            deterministic_analysis: { warnings: [] },
            generated_analysis: generatedAnalysis,
          },
        ],
        error: null,
      };
    }
    if (call.table === "altien_skills" && call.op === "select") {
      return {
        data: [
          {
            id: "skill-1",
            canonical_name: "reader",
            display_name: "Reader",
            description: "Reads documents",
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
            manifest: {
              files: [
                {
                  path: "reader/SKILL.md",
                  bytes: 42,
                  media_type: "text/markdown",
                  inspection_class: "text",
                  sha256: "file-hash",
                  document_version_id: "document-version-1",
                },
                {
                  path: "reader/logo.png",
                  bytes: 9,
                  media_type: "image/png",
                  inspection_class: "binary",
                  sha256: "binary-hash",
                  document_version_id: "document-version-2",
                },
              ],
            },
          },
        ],
        error: null,
      };
    }
    if (call.table === "altien_skill_import_conversations") {
      return { data: [{ id: "conversation-1" }], error: null };
    }
    if (call.table === "document_versions" && call.op === "select") {
      return { data: [{ storage_path: "skills/reader.md" }], error: null };
    }
    if (call.table === "altien_skill_pending_actions" && call.op === "select") {
      const byActionType = call.filters.some(
        (filter) => filter[1] === "action_type",
      );
      if (byActionType) return { data: options.acquisitions ?? [], error: null };
      return { data: options.pending ? [options.pending] : [], error: null };
    }
    return { data: [], error: null };
  });
}

/** Proposes the enable action once and returns the exact inserted row. */
async function proposeEnable(fake: ReturnType<typeof enableDb>) {
  await postSkillReviewMessage({
    tenantId: "tenant-1",
    versionId: "version-1",
    userId: "admin-1",
    message: "enable",
    db: fake.db as never,
    settings: fastModelSettings,
  });
  const inserted = fake.callsFor("altien_skill_pending_actions", "insert")[0]
    .payload as Record<string, unknown>;
  return {
    id: String(inserted.id),
    version_id: "version-1",
    action_type: inserted.action_type,
    payload: inserted.payload,
    payload_hash: inserted.payload_hash,
    state: "pending",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function pendingRow(
  inserted: Record<string, unknown>,
  actionType: string,
): Record<string, unknown> {
  return {
    id: inserted.id,
    version_id: "version-1",
    action_type: actionType,
    payload: inserted.payload,
    payload_hash: inserted.payload_hash,
    state: "pending",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

describe("pending action amendment", () => {
  it("advertises the amendment syntax on the enable proposal", async () => {
    const fake = enableDb();
    const result = await postSkillReviewMessage({
      tenantId: "tenant-1",
      versionId: "version-1",
      userId: "admin-1",
      message: "enable",
      db: fake.db as never,
      settings: fastModelSettings,
    });
    expect(result).toMatchObject({
      outcome: "proposed",
      action: { actionType: "enable_version" },
    });
    const conversation = fake
      .callsFor("altien_skill_import_messages", "insert")
      .map((call) => String((call.payload as { content: string }).content))
      .join("\n");
    expect(conversation).toContain("amend allow <requirement> =>");
    expect(conversation).toContain("read <path>");
    expect(conversation).toContain("grants nothing until you select a minimum set");
  });

  it("supersedes the reviewed action and hashes exactly the amended content", async () => {
    const pending = await proposeEnable(enableDb());
    const fake = enableDb({ pending });

    const result = await postSkillReviewMessage({
      tenantId: "tenant-1",
      versionId: "version-1",
      userId: "admin-1",
      message: "amend allow appropriate tools => generate_docx",
      db: fake.db as never,
      settings: fastModelSettings,
    });

    expect(result).toMatchObject({
      outcome: "amended",
      supersededActionId: pending.id,
    });
    expect(
      fake.callsFor("altien_skill_pending_actions", "update")[0].payload,
    ).toMatchObject({ state: "superseded" });
    const inserted = fake.callsFor("altien_skill_pending_actions", "insert")[0]
      .payload as Record<string, unknown>;
    expect(inserted.action_type).toBe("enable_version");
    const payload = inserted.payload as {
      amendedFromActionId: string;
      executionContract: {
        approvedToolNames: string[];
        mappings: Array<Record<string, unknown>>;
      };
    };
    expect(payload.amendedFromActionId).toBe(pending.id);
    expect(payload.executionContract.approvedToolNames).toEqual([
      ...PROJECT_BASELINE,
      "generate_docx",
    ]);
    expect(payload.executionContract.mappings[1]).toMatchObject({
      status: "admin_selected",
      mappedToolNames: ["generate_docx"],
    });
    // The new hash covers the amended payload, not the reviewed one.
    expect(inserted.payload_hash).toBe(
      hashActionPayload(payload as unknown as Record<string, unknown>),
    );
    expect(inserted.payload_hash).not.toBe(pending.payload_hash);
  });

  it("restricts the approved tool set without ever adding to it", async () => {
    const pending = await proposeEnable(enableDb());
    const fake = enableDb({ pending });

    await postSkillReviewMessage({
      tenantId: "tenant-1",
      versionId: "version-1",
      userId: "admin-1",
      message: "amend tools list_documents",
      db: fake.db as never,
      settings: fastModelSettings,
    });

    const inserted = fake.callsFor("altien_skill_pending_actions", "insert")[0]
      .payload as {
      payload: { executionContract: { approvedToolNames: string[] } };
    };
    expect(inserted.payload.executionContract.approvedToolNames).toEqual([
      "list_documents",
    ]);

    const adding = enableDb({ pending });
    await expect(
      postSkillReviewMessage({
        tenantId: "tenant-1",
        versionId: "version-1",
        userId: "admin-1",
        message: "amend tools edit_document",
        db: adding.db as never,
        settings: fastModelSettings,
      }),
    ).rejects.toThrow("was not in the reviewed approved set");
    expect(
      adding.callsFor("altien_skill_pending_actions", "insert"),
    ).toHaveLength(0);
  });

  it("refuses a name-match candidate the administrator rejects", async () => {
    const pending = await proposeEnable(enableDb());
    const fake = enableDb({ pending });
    await postSkillReviewMessage({
      tenantId: "tenant-1",
      versionId: "version-1",
      userId: "admin-1",
      message: "amend reject appropriate tools",
      db: fake.db as never,
      settings: fastModelSettings,
    });
    const inserted = fake.callsFor("altien_skill_pending_actions", "insert")[0]
      .payload as {
      payload: { executionContract: { mappings: Array<Record<string, unknown>> } };
    };
    expect(inserted.payload.executionContract.mappings[1]).toMatchObject({
      status: "admin_rejected",
      mappedToolNames: [],
    });
  });

  it("enables exactly the amended contract once the new hash is authorized", async () => {
    const pending = await proposeEnable(enableDb());
    const amending = enableDb({ pending });
    await postSkillReviewMessage({
      tenantId: "tenant-1",
      versionId: "version-1",
      userId: "admin-1",
      message: "amend tools list_documents",
      db: amending.db as never,
      settings: fastModelSettings,
    });
    const amended = amending.callsFor(
      "altien_skill_pending_actions",
      "insert",
    )[0].payload as Record<string, unknown>;
    const fake = enableDb({ pending: pendingRow(amended, "enable_version") });

    const result = await postSkillReviewMessage({
      tenantId: "tenant-1",
      versionId: "version-1",
      userId: "admin-1",
      message: "yes",
      db: fake.db as never,
      settings: fastModelSettings,
    });

    expect(result).toMatchObject({ outcome: "enabled" });
    const enabled = fake
      .callsFor("altien_skill_versions", "update")
      .map((call) => call.payload as Record<string, unknown>)
      .find((payload) => payload.state === "enabled");
    expect(
      (enabled?.approved_execution_contract as { approvedToolNames: string[] })
        .approvedToolNames,
    ).toEqual(["list_documents"]);
  });

  it("rejects a tampered amended payload on approval", async () => {
    const pending = await proposeEnable(enableDb());
    const fake = enableDb({
      pending: {
        ...pending,
        payload: {
          ...(pending.payload as Record<string, unknown>),
          executionContract: { approvedToolNames: ["generate_docx"] },
        },
      },
    });
    await expect(
      postSkillReviewMessage({
        tenantId: "tenant-1",
        versionId: "version-1",
        userId: "admin-1",
        message: "yes",
        db: fake.db as never,
        settings: fastModelSettings,
      }),
    ).rejects.toThrow("Pending action payload hash mismatch.");
  });

  it("proposes a rename as its own superseding action", async () => {
    const pending = await proposeEnable(enableDb());
    const fake = enableDb({ pending });
    const result = await postSkillReviewMessage({
      tenantId: "tenant-1",
      versionId: "version-1",
      userId: "admin-1",
      message: "amend rename Contract Reader",
      db: fake.db as never,
      settings: fastModelSettings,
    });
    expect(result).toMatchObject({ outcome: "amended" });
    expect(
      fake.callsFor("altien_skill_pending_actions", "insert")[0].payload,
    ).toMatchObject({
      action_type: "rename_skill",
      payload: {
        currentDisplayName: "Reader",
        newDisplayName: "Contract Reader",
      },
    });
  });

  it("applies an authorized rename through the ordinary adaptation path", async () => {
    const pending = await proposeEnable(enableDb());
    const proposing = enableDb({ pending });
    await postSkillReviewMessage({
      tenantId: "tenant-1",
      versionId: "version-1",
      userId: "admin-1",
      message: "amend rename Contract Reader",
      db: proposing.db as never,
      settings: fastModelSettings,
    });
    const renameAction = proposing.callsFor(
      "altien_skill_pending_actions",
      "insert",
    )[0].payload as Record<string, unknown>;
    const rename = vi.fn().mockResolvedValue({
      displayName: "Contract Reader",
      canonicalName: "contract-reader",
      contentHash: "adapted-hash",
    });
    const fake = enableDb({ pending: pendingRow(renameAction, "rename_skill") });

    const result = await postSkillReviewMessage({
      tenantId: "tenant-1",
      versionId: "version-1",
      userId: "admin-1",
      message: "yes",
      db: fake.db as never,
      rename: rename as never,
      settings: fastModelSettings,
    });

    expect(result).toMatchObject({ outcome: "renamed" });
    expect(rename).toHaveBeenCalledWith(
      expect.objectContaining({ newDisplayName: "Contract Reader" }),
    );
  });

  it("refuses an amendment when nothing is pending", async () => {
    const fake = enableDb();
    await expect(
      postSkillReviewMessage({
        tenantId: "tenant-1",
        versionId: "version-1",
        userId: "admin-1",
        message: "amend tools list_documents",
        db: fake.db as never,
        settings: fastModelSettings,
      }),
    ).rejects.toThrow("There is no pending action to amend.");
  });
});

describe("review snapshot commands", () => {
  it("lists the immutable snapshot without proposing anything", async () => {
    const fake = enableDb();
    const result = await postSkillReviewMessage({
      tenantId: "tenant-1",
      versionId: "version-1",
      userId: "admin-1",
      message: "list",
      db: fake.db as never,
      settings: fastModelSettings,
    });
    expect(result).toMatchObject({
      outcome: "snapshot",
      command: { kind: "list" },
      result: [
        expect.objectContaining({
          path: "reader/logo.png",
          readable: false,
          inert_reason: "binary",
        }),
        expect.objectContaining({ path: "reader/SKILL.md", readable: true }),
      ],
    });
    expect(
      fake.callsFor("altien_skill_pending_actions", "insert"),
    ).toHaveLength(0);
  });

  it("reads one bounded text entry and searches the snapshot", async () => {
    downloadFileMock.mockResolvedValue(
      new TextEncoder().encode("Read the selected project documents.").buffer,
    );
    await expect(
      postSkillReviewMessage({
        tenantId: "tenant-1",
        versionId: "version-1",
        userId: "admin-1",
        message: "read reader/SKILL.md",
        db: enableDb().db as never,
        settings: fastModelSettings,
      }),
    ).resolves.toMatchObject({
      outcome: "snapshot",
      result: {
        path: "reader/SKILL.md",
        text: "Read the selected project documents.",
      },
    });

    await expect(
      postSkillReviewMessage({
        tenantId: "tenant-1",
        versionId: "version-1",
        userId: "admin-1",
        message: "search project documents",
        db: enableDb().db as never,
        settings: fastModelSettings,
      }),
    ).resolves.toMatchObject({
      outcome: "snapshot",
      result: {
        matches: [expect.objectContaining({ path: "reader/SKILL.md" })],
      },
    });
  });

  it("refuses to read an inert entry or a path outside the manifest", async () => {
    for (const message of ["read reader/logo.png", "read ../secrets.env"]) {
      await expect(
        postSkillReviewMessage({
          tenantId: "tenant-1",
          versionId: "version-1",
          userId: "admin-1",
          message,
          db: enableDb().db as never,
          settings: fastModelSettings,
        }),
      ).rejects.toThrow();
    }
  });
});

const declaredDependency = {
  dependencies:
    "citation-checker https://github.com/acme/citation-checker/tree/main/skills/citation-checker",
};

describe("declared dependency acquisition", () => {
  it("proposes an exact acquisition payload instead of fetching", async () => {
    const fake = enableDb({ declaredMetadata: declaredDependency });
    const result = await postSkillReviewMessage({
      tenantId: "tenant-1",
      versionId: "version-1",
      userId: "admin-1",
      message: "enable",
      db: fake.db as never,
      settings: fastModelSettings,
    });
    expect(result).toMatchObject({
      outcome: "proposed",
      action: { actionType: "acquire_dependency" },
    });
    expect(
      fake.callsFor("altien_skill_pending_actions", "insert")[0].payload,
    ).toMatchObject({
      action_type: "acquire_dependency",
      payload: {
        dependencyName: "citation-checker",
        repository: "acme/citation-checker",
        ref: "main",
        path: "skills/citation-checker",
      },
    });
  });

  it("acquires through the gated GitHub path only after authorization", async () => {
    const proposing = enableDb({ declaredMetadata: declaredDependency });
    await postSkillReviewMessage({
      tenantId: "tenant-1",
      versionId: "version-1",
      userId: "admin-1",
      message: "enable",
      db: proposing.db as never,
      settings: fastModelSettings,
    });
    const proposed = proposing.callsFor(
      "altien_skill_pending_actions",
      "insert",
    )[0].payload as Record<string, unknown>;
    const acquire = vi.fn().mockResolvedValue({
      sourceBytes: new Uint8Array([1]),
      snapshot: { treeHash: "tree" },
      provenance: {
        repository: "acme/citation-checker",
        selectedPath: "skills/citation-checker",
        requestedRef: "main",
        resolvedCommitSha: "abcdef1234567890",
      },
    });
    const storeSnapshot = vi
      .fn()
      .mockResolvedValue({ id: "snapshot-2", skills: [{ id: "skill-2" }] });
    const approving = enableDb({
      declaredMetadata: declaredDependency,
      pending: pendingRow(proposed, "acquire_dependency"),
    });

    const result = await postSkillReviewMessage({
      tenantId: "tenant-1",
      versionId: "version-1",
      userId: "admin-1",
      message: "yes",
      db: approving.db as never,
      settings: fastModelSettings,
      acquire: acquire as never,
      storeSnapshot: storeSnapshot as never,
      githubPolicy: vi.fn().mockResolvedValue({
        deploymentAllowed: true,
        tenantEnabled: true,
      }) as never,
      githubToken: vi.fn().mockResolvedValue(null) as never,
    });

    expect(result).toMatchObject({
      outcome: "acquired",
      snapshotId: "snapshot-2",
    });
    expect(acquire).toHaveBeenCalledWith({
      url: "https://github.com/acme/citation-checker/tree/main/skills/citation-checker",
      token: undefined,
    });
    expect(storeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-1", sourceKind: "github" }),
    );
    // Acquisition creates a draft only: no binding and no enablement.
    expect(
      approving.callsFor("altien_skill_dependencies", "insert"),
    ).toHaveLength(0);
    expect(approving.callsFor("altien_skill_versions", "update")).toHaveLength(0);
  });

  it("still refuses acquisition when the deployment gate is closed", async () => {
    const proposing = enableDb({ declaredMetadata: declaredDependency });
    await postSkillReviewMessage({
      tenantId: "tenant-1",
      versionId: "version-1",
      userId: "admin-1",
      message: "enable",
      db: proposing.db as never,
      settings: fastModelSettings,
    });
    const proposed = proposing.callsFor(
      "altien_skill_pending_actions",
      "insert",
    )[0].payload as Record<string, unknown>;
    const acquire = vi.fn();

    await expect(
      postSkillReviewMessage({
        tenantId: "tenant-1",
        versionId: "version-1",
        userId: "admin-1",
        message: "yes",
        db: enableDb({
          declaredMetadata: declaredDependency,
          pending: pendingRow(proposed, "acquire_dependency"),
        }).db as never,
        settings: fastModelSettings,
        acquire: acquire as never,
        githubPolicy: vi.fn().mockResolvedValue({
          deploymentAllowed: false,
          tenantEnabled: true,
        }) as never,
        githubToken: vi.fn().mockResolvedValue(null) as never,
      }),
    ).rejects.toThrow("GITHUB_SKILL_IMPORT_DEPLOYMENT_DENIED");
    expect(acquire).not.toHaveBeenCalled();
  });

  it("never lets “enable” authorize a pending acquisition", async () => {
    const proposing = enableDb({ declaredMetadata: declaredDependency });
    await postSkillReviewMessage({
      tenantId: "tenant-1",
      versionId: "version-1",
      userId: "admin-1",
      message: "enable",
      db: proposing.db as never,
      settings: fastModelSettings,
    });
    const proposed = proposing.callsFor(
      "altien_skill_pending_actions",
      "insert",
    )[0].payload as Record<string, unknown>;
    const acquire = vi.fn();
    const fake = enableDb({
      declaredMetadata: declaredDependency,
      pending: pendingRow(proposed, "acquire_dependency"),
      acquisitions: [{ state: "pending", payload: proposed.payload }],
    });

    const result = await postSkillReviewMessage({
      tenantId: "tenant-1",
      versionId: "version-1",
      userId: "admin-1",
      message: "enable",
      db: fake.db as never,
      settings: fastModelSettings,
      acquire: acquire as never,
    });

    expect(acquire).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "proposed",
      action: { actionType: "enable_version" },
    });
  });

  it("does not re-propose an acquisition that was already handled", async () => {
    const fake = enableDb({
      declaredMetadata: declaredDependency,
      acquisitions: [
        {
          state: "rejected",
          payload: {
            url: "https://github.com/acme/citation-checker/tree/main/skills/citation-checker",
          },
        },
      ],
    });
    const result = await postSkillReviewMessage({
      tenantId: "tenant-1",
      versionId: "version-1",
      userId: "admin-1",
      message: "enable",
      db: fake.db as never,
      settings: fastModelSettings,
    });
    expect(result).toMatchObject({
      outcome: "proposed",
      action: { actionType: "enable_version" },
    });
  });
});
