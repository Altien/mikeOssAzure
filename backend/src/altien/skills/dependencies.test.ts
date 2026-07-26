import { describe, expect, it } from "vitest";
import { makeFakeDb } from "../../test/helpers/fakeDb";
import { resolveSkillDependencyGraph } from "./dependencies";

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
