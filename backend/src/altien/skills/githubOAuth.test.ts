import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb } from "../../test/helpers/fakeDb";

const { encryptStringMock, decryptStringMock } = vi.hoisted(() => ({
  encryptStringMock: vi.fn(),
  decryptStringMock: vi.fn(),
}));

vi.mock("../../lib/mcp/client", () => ({
  encryptString: encryptStringMock,
  decryptString: decryptStringMock,
}));

import {
  completeGitHubSkillOAuth,
  startGitHubSkillOAuth,
} from "./githubOAuth";

describe("tenant GitHub skill OAuth", () => {
  beforeEach(() => {
    process.env.GITHUB_SKILL_OAUTH_CLIENT_ID = "client-id";
    process.env.GITHUB_SKILL_OAUTH_CLIENT_SECRET = "client-secret";
    encryptStringMock.mockReset();
    decryptStringMock.mockReset();
    encryptStringMock.mockResolvedValue({
      encrypted: "encrypted-token",
      iv: "iv",
      tag: "tag",
    });
  });

  afterEach(() => {
    delete process.env.GITHUB_SKILL_OAUTH_CLIENT_ID;
    delete process.env.GITHUB_SKILL_OAUTH_CLIENT_SECRET;
  });

  it("stores a hashed short-lived state and requests repository access", async () => {
    const fake = makeFakeDb(() => ({ data: null, error: null }));
    const result = await startGitHubSkillOAuth({
      tenantId: "tenant-1",
      userId: "admin-1",
      redirectUri: "https://mike.example/api/altien/skills/settings/github/oauth/callback",
      db: fake.db as never,
    });
    const url = new URL(result.authorizationUrl);
    expect(url.origin).toBe("https://github.com");
    expect(url.searchParams.get("scope")).toBe("repo");
    expect(url.searchParams.get("state")).toBeTruthy();
    const stateInsert = fake.callsFor(
      "altien_skill_github_oauth_states",
      "insert",
    )[0];
    expect(stateInsert.payload).toMatchObject({
      tenant_id: "tenant-1",
      created_by: "admin-1",
    });
    expect(
      (stateInsert.payload as Record<string, unknown>).state_hash,
    ).not.toBe(url.searchParams.get("state"));
  });

  it("exchanges the code and stores only an encrypted tenant token", async () => {
    const fake = makeFakeDb((call) => {
      if (
        call.table === "altien_skill_github_oauth_states" &&
        call.op === "select"
      ) {
        return {
          data: [{
            id: "state-1",
            tenant_id: "tenant-1",
            created_by: "admin-1",
            redirect_uri: "https://mike.example/callback",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          }],
          error: null,
        };
      }
      if (
        call.table === "altien_skill_github_connections" &&
        call.op === "select"
      ) {
        return { data: [], error: null };
      }
      return { data: null, error: null };
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "secret-token", scope: "repo" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 42, login: "octocat" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-OAuth-Scopes": "repo",
          },
        }),
      );
    await expect(
      completeGitHubSkillOAuth({
        state: "raw-state",
        code: "code",
        db: fake.db as never,
        fetcher,
      }),
    ).resolves.toMatchObject({
      tenantId: "tenant-1",
      githubLogin: "octocat",
    });
    expect(encryptStringMock).toHaveBeenCalledWith("secret-token");
    const insert = fake.callsFor(
      "altien_skill_github_connections",
      "insert",
    )[0];
    expect(insert.payload).toMatchObject({
      tenant_id: "tenant-1",
      encrypted_access_token: "encrypted-token",
      github_login: "octocat",
    });
    expect(JSON.stringify(insert.payload)).not.toContain("secret-token");
  });
});

