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

function redirect(location: string, status = 302) {
  return new Response(null, { status, headers: { location } });
}

describe("GitHub rate limiting", () => {
  // GitHub answers an exhausted quota with the same 403 it uses for a private
  // repository, which read as "connect OAuth" for a public one.
  function exhausted() {
    return new Response("", {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1785112944",
      },
    });
  }

  it("reports an exhausted quota as rate limiting, not authorization", async () => {
    await expect(
      acquireGitHubSkill({
        url: "https://github.com/owner/repo",
        fetcher: async () => exhausted(),
      }),
    ).rejects.toMatchObject({ code: "github_rate_limited" });
  });

  it("tells an anonymous caller that connecting GitHub raises the limit", async () => {
    await expect(
      acquireGitHubSkill({
        url: "https://github.com/owner/repo",
        fetcher: async () => exhausted(),
      }),
    ).rejects.toThrow(/60 an hour.*Account → Connectors/s);
  });

  it("does not suggest connecting when a token was already used", async () => {
    await expect(
      acquireGitHubSkill({
        url: "https://github.com/owner/repo",
        token: "tenant-token",
        fetcher: async () => exhausted(),
      }),
    ).rejects.toThrow(/Wait for the limit to reset/);
  });

  it("still reports a real permission failure as authorization", async () => {
    await expect(
      acquireGitHubSkill({
        url: "https://github.com/owner/repo",
        fetcher: async () =>
          new Response("", {
            status: 403,
            headers: { "x-ratelimit-remaining": "58" },
          }),
      }),
    ).rejects.toMatchObject({ code: "github_authorization_required" });
  });
});

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

  it("never issues the request for an off-host redirect target", async () => {
    const calls: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return redirect("https://evil.example/steal");
    }) as typeof fetch;
    await expect(
      checkGitHubSourceUpdate({
        repository: "github.com/example/skills",
        requestedRef: "main",
        selectedPath: "",
        lastResolvedCommitSha: "a".repeat(40),
        fetcher,
      }),
    ).rejects.toThrow("redirected outside api.github.com");
    // Only the original api.github.com request happened; the off-host target
    // was rejected before it could be fetched.
    expect(calls).toHaveLength(1);
    expect(calls.every((call) => call.startsWith("https://api.github.com/"))).toBe(
      true,
    );
  });

  it("rejects a redirect that downgrades the scheme or adds credentials", async () => {
    for (const location of [
      "http://api.github.com/repos/example/skills/commits/main",
      "https://user:pass@api.github.com/repos/example/skills/commits/main",
      "https://api.github.com.evil.example/repos/example/skills/commits/main",
    ]) {
      const calls: string[] = [];
      const fetcher = (async (input: string | URL | Request) => {
        calls.push(String(input));
        return redirect(location);
      }) as typeof fetch;
      await expect(
        checkGitHubSourceUpdate({
          repository: "github.com/example/skills",
          requestedRef: "main",
          selectedPath: "",
          lastResolvedCommitSha: "a".repeat(40),
          fetcher,
        }),
      ).rejects.toThrow("redirected outside api.github.com");
      expect(calls).toHaveLength(1);
    }
  });

  it("follows a redirect that stays on api.github.com", async () => {
    const calls: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/repos/example/skills/commits/main")) {
        // Relative Location, as GitHub emits for renamed repositories.
        return redirect("/repos/example/skills-renamed/commits/main", 301);
      }
      return json({ sha: "b".repeat(40) });
    }) as typeof fetch;
    await expect(
      checkGitHubSourceUpdate({
        repository: "github.com/example/skills",
        requestedRef: "main",
        selectedPath: "",
        lastResolvedCommitSha: "a".repeat(40),
        fetcher,
      }),
    ).resolves.toMatchObject({
      updateAvailable: true,
      currentCommitSha: "b".repeat(40),
    });
    expect(calls).toEqual([
      "https://api.github.com/repos/example/skills/commits/main",
      "https://api.github.com/repos/example/skills-renamed/commits/main",
    ]);
  });

  it("stops following after the redirect hop limit", async () => {
    const calls: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return redirect(`https://api.github.com/hop/${calls.length}`);
    }) as typeof fetch;
    await expect(
      checkGitHubSourceUpdate({
        repository: "github.com/example/skills",
        requestedRef: "main",
        selectedPath: "",
        lastResolvedCommitSha: "a".repeat(40),
        fetcher,
      }),
    ).rejects.toThrow("redirect hops");
    // Original request plus at most three followed hops.
    expect(calls).toHaveLength(4);
  });
});
