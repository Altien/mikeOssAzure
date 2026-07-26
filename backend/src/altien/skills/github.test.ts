import { describe, expect, it } from "vitest";
import {
  acquireGitHubSkill,
  checkGitHubSourceUpdate,
  parseGitHubSourceUrl,
} from "./github";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GitHub skill acquisition", () => {
  it("accepts only github.com repository and tree URLs", () => {
    expect(
      parseGitHubSourceUrl(
        "https://github.com/example/skills/tree/release/v1/legal",
      ),
    ).toEqual({
      owner: "example",
      repository: "skills",
      treeTail: ["release", "v1", "legal"],
    });
    expect(() =>
      parseGitHubSourceUrl("https://github.example.com/example/skills"),
    ).toThrow("Only HTTPS github.com");
    expect(() =>
      parseGitHubSourceUrl("https://github.com/example/skills/issues/1"),
    ).toThrow("repository root or /tree");
  });

  it("resolves a mutable ref to a commit and preserves a selected subtree", async () => {
    const skill = Buffer.from(
      "---\nname: GitHub Reader\ndescription: Reads files\n---\nRead them.",
    );
    const guide = Buffer.from("Guide");
    const calls: string[] = [];
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/repos/example/skills")) {
        return json({
          default_branch: "main",
          private: false,
          full_name: "example/skills",
        });
      }
      if (url.includes("/commits/release%2Fv1%2Flegal")) return json({}, 404);
      if (url.includes("/commits/release%2Fv1")) return json({ sha: "commit-1" });
      if (url.includes("/git/trees/commit-1")) {
        return json({
          truncated: false,
          tree: [
            {
              path: "legal/SKILL.md",
              mode: "100644",
              type: "blob",
              sha: "skill-blob",
              size: skill.length,
            },
            {
              path: "legal/references/guide.md",
              mode: "100644",
              type: "blob",
              sha: "guide-blob",
              size: guide.length,
            },
            {
              path: "outside.txt",
              mode: "100644",
              type: "blob",
              sha: "outside",
              size: 2,
            },
          ],
        });
      }
      if (url.endsWith("/git/blobs/skill-blob")) {
        return json({
          encoding: "base64",
          content: skill.toString("base64"),
          size: skill.length,
        });
      }
      if (url.endsWith("/git/blobs/guide-blob")) {
        return json({
          encoding: "base64",
          content: guide.toString("base64"),
          size: guide.length,
        });
      }
      return json({}, 404);
    };

    const result = await acquireGitHubSkill({
      url: "https://github.com/example/skills/tree/release/v1/legal",
      fetcher: fetcher as typeof fetch,
    });

    expect(result.provenance).toMatchObject({
      repository: "github.com/example/skills",
      selectedPath: "legal",
      requestedRef: "release/v1",
      resolvedCommitSha: "commit-1",
    });
    expect(result.snapshot.files.map((file) => file.relativePath)).toEqual(
      expect.arrayContaining(["SKILL.md", "references/guide.md"]),
    );
    expect(calls.some((call) => call.includes("outside"))).toBe(false);
  });

  it("rejects submodules instead of following them", async () => {
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/repos/example/skills")) {
        return json({ default_branch: "main", private: false });
      }
      if (url.includes("/commits/main")) return json({ sha: "commit-1" });
      if (url.includes("/git/trees/commit-1")) {
        return json({
          truncated: false,
          tree: [
            {
              path: "vendor",
              mode: "160000",
              type: "commit",
              sha: "submodule",
            },
          ],
        });
      }
      return json({}, 404);
    };
    await expect(
      acquireGitHubSkill({
        url: "https://github.com/example/skills",
        fetcher: fetcher as typeof fetch,
      }),
    ).rejects.toThrow("submodules");
  });

  it("checks a tracked ref without downloading or promoting content", async () => {
    const calls: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return json({ sha: "b".repeat(40) });
    }) as typeof fetch;
    await expect(
      checkGitHubSourceUpdate({
        repository: "github.com/example/skills",
        requestedRef: "main",
        selectedPath: "legal",
        lastResolvedCommitSha: "a".repeat(40),
        fetcher,
      }),
    ).resolves.toMatchObject({
      updateAvailable: true,
      previousCommitSha: "a".repeat(40),
      currentCommitSha: "b".repeat(40),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/commits/main");
  });
});
