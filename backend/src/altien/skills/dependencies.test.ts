import { describe, expect, it } from "vitest";
import { makeFakeDb } from "../../test/helpers/fakeDb";
import {
  resolveSkillDependencyGraph,
  resolvedDependencyBindings,
} from "./dependencies";

describe("resolveSkillDependencyGraph", () => {
  it("resolves exact dependency versions in dependency-first order", async () => {
    const edges: Record<string, string[]> = {
      root: ["dep-a", "dep-b"],
      "dep-a": ["dep-c"],
      "dep-b": [],
      "dep-c": [],
    };
    const fake = makeFakeDb((call) => {
      const versionId = String(call.filters[0]?.[2]);
      return {
        data: (edges[versionId] ?? []).map((dependencyVersionId) => ({
          version_id: versionId,
          dependency_skill_id: `skill-${dependencyVersionId}`,
          dependency_version_id: dependencyVersionId,
          required: true,
        })),
        error: null,
      };
    });
    await expect(
      resolveSkillDependencyGraph({
        rootVersionId: "root",
        db: fake.db as never,
      }),
    ).resolves.toEqual(["dep-c", "dep-a", "dep-b"]);
  });

  it("rejects cycles", async () => {
    const fake = makeFakeDb((call) => {
      const versionId = String(call.filters[0]?.[2]);
      const next = versionId === "root" ? "dep" : "root";
      return {
        data: [
          {
            version_id: versionId,
            dependency_skill_id: `skill-${next}`,
            dependency_version_id: next,
            required: true,
          },
        ],
        error: null,
      };
    });
    await expect(
      resolveSkillDependencyGraph({
        rootVersionId: "root",
        db: fake.db as never,
      }),
    ).rejects.toThrow("cycle");
  });
});

describe("resolvedDependencyBindings", () => {
  function makeDependencyDb(dependencyState: string) {
    return makeFakeDb((call) => {
      const id = call.filters.find((filter) => filter[1] === "id")?.[2];
      if (call.table === "altien_skill_dependencies") {
        const versionId = String(call.filters[0]?.[2]);
        return {
          data:
            versionId === "version-root"
              ? [
                  {
                    version_id: "version-root",
                    dependency_skill_id: "skill-dependency",
                    dependency_version_id: "version-dependency",
                    required: true,
                  },
                ]
              : [],
          error: null,
        };
      }
      if (call.table === "altien_skill_versions") {
        return {
          data: [
            {
              id,
              skill_id: "skill-dependency",
              state: dependencyState,
              original_content_hash: "hash-dependency",
              adapted_content_hash: null,
              approved_execution_contract: { approvedToolNames: ["find_in_document"] },
            },
          ],
          error: null,
        };
      }
      if (call.table === "altien_skills") {
        return {
          data: [
            {
              id: "skill-dependency",
              canonical_name: "helper",
              display_name: "Helper",
            },
          ],
          error: null,
        };
      }
      return { data: [], error: null };
    });
  }

  it("binds dependencies that still resolve to an enabled version", async () => {
    const fake = makeDependencyDb("enabled");
    await expect(
      resolvedDependencyBindings("version-root", fake.db as never),
    ).resolves.toEqual([
      {
        skillId: "skill-dependency",
        canonicalName: "helper",
        displayName: "Helper",
        versionId: "version-dependency",
        contentHash: "hash-dependency",
        executionContract: { approvedToolNames: ["find_in_document"] },
      },
    ]);
  });

  it("fails the bind when a declared dependency was disabled after declaration", async () => {
    const fake = makeDependencyDb("disabled");
    await expect(
      resolvedDependencyBindings("version-root", fake.db as never),
    ).rejects.toMatchObject({
      code: "dependency_not_enabled",
      message: expect.stringContaining("Helper"),
      dependency: {
        versionId: "version-dependency",
        canonicalName: "helper",
        state: "disabled",
      },
    });
  });
});
