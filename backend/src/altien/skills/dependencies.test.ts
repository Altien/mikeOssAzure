import { describe, expect, it } from "vitest";
import { makeFakeDb } from "../../test/helpers/fakeDb";
import {
  declaredGitHubDependencies,
  missingDeclaredGitHubDependencies,
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

describe("declared GitHub dependencies", () => {
  const version = {
    declared_metadata: {
      name: "citation-review",
      dependencies: `citation-checker https://github.com/acme/citation-checker/tree/v2/skills/citation-checker
helper https://github.com/acme/helper
internal-tool https://gitlab.example.com/acme/internal
prose about a dependency with no link`,
    },
  };

  it("reads only exact github.com locations out of the frontmatter", () => {
    expect(declaredGitHubDependencies(version)).toEqual([
      {
        name: "citation-checker",
        url: "https://github.com/acme/citation-checker/tree/v2/skills/citation-checker",
        owner: "acme",
        repository: "acme/citation-checker",
        ref: "v2",
        path: "skills/citation-checker",
      },
      {
        name: "helper",
        url: "https://github.com/acme/helper",
        owner: "acme",
        repository: "acme/helper",
        ref: null,
        path: null,
      },
    ]);
  });

  it("ignores a version with no declared dependencies", () => {
    expect(declaredGitHubDependencies({ declared_metadata: {} })).toEqual([]);
    expect(declaredGitHubDependencies({})).toEqual([]);
  });

  it("reports only declarations with no approved binding", async () => {
    const fake = makeFakeDb((call) => {
      if (call.table === "altien_skill_dependencies") {
        return {
          data: [
            {
              version_id: "version-root",
              dependency_skill_id: "skill-helper",
              dependency_version_id: "version-helper",
              required: true,
            },
          ],
          error: null,
        };
      }
      if (call.table === "altien_skill_versions") {
        return {
          data: [
            {
              id: "version-helper",
              skill_id: "skill-helper",
              original_content_hash: "hash-helper",
              approved_execution_contract: {},
            },
          ],
          error: null,
        };
      }
      if (call.table === "altien_skills") {
        return {
          data: [
            {
              id: "skill-helper",
              canonical_name: "helper",
              display_name: "Helper",
            },
          ],
          error: null,
        };
      }
      return { data: [], error: null };
    });

    await expect(
      missingDeclaredGitHubDependencies({
        version,
        versionId: "version-root",
        db: fake.db as never,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ name: "citation-checker" }),
    ]);
  });
});
