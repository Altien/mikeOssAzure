import { describe, expect, it, vi } from "vitest";
import { makeFakeDb } from "../../test/helpers/fakeDb";

const { downloadFileMock } = vi.hoisted(() => ({
  downloadFileMock: vi.fn(),
}));

vi.mock("../../lib/storage", () => ({
  downloadFile: downloadFileMock,
}));

import { analyseSkillVersion } from "./review";

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
