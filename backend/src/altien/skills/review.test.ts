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
