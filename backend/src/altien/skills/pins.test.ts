import { describe, expect, it } from "vitest";
import { makeFakeDb } from "../../test/helpers/fakeDb";
import { setProjectSkillPin } from "./pins";

describe("project skill pins", () => {
  it("pins only an enabled exact version in the same tenant skill", async () => {
    const fake = makeFakeDb((call) => {
      if (call.table === "altien_skills") {
        return { data: [{ id: "skill-1", display_name: "Reader" }], error: null };
      }
      if (call.table === "altien_skill_versions") {
        return {
          data: [{
            id: "version-1",
            skill_id: "skill-1",
            state: "enabled",
            original_content_hash: "hash-1",
          }],
          error: null,
        };
      }
      if (
        call.table === "altien_project_skill_pins" &&
        call.op === "select"
      ) {
        return { data: [], error: null };
      }
      return { data: null, error: null };
    });
    await expect(
      setProjectSkillPin({
        tenantId: "tenant-1",
        projectId: "project-1",
        skillId: "skill-1",
        versionId: "version-1",
        pinnedBy: "owner-1",
        db: fake.db as never,
      }),
    ).resolves.toMatchObject({
      versionId: "version-1",
      contentHash: "hash-1",
    });
    expect(fake.callsFor("altien_project_skill_pins", "insert")).toHaveLength(1);
  });

  it("rejects a disabled target version", async () => {
    const fake = makeFakeDb((call) => {
      if (call.table === "altien_skills") {
        return { data: [{ id: "skill-1", display_name: "Reader" }], error: null };
      }
      if (call.table === "altien_skill_versions") {
        return { data: [{ id: "version-1", state: "disabled" }], error: null };
      }
      return { data: [], error: null };
    });
    await expect(
      setProjectSkillPin({
        tenantId: "tenant-1",
        projectId: "project-1",
        skillId: "skill-1",
        versionId: "version-1",
        pinnedBy: "owner-1",
        db: fake.db as never,
      }),
    ).rejects.toThrow("enabled");
  });
});

