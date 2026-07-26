import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, type DbCall } from "../../test/helpers/fakeDb";

const { encryptStringMock, decryptStringMock } = vi.hoisted(() => ({
  encryptStringMock: vi.fn(),
  decryptStringMock: vi.fn(),
}));

vi.mock("../../lib/mcp/client", () => ({
  encryptString: encryptStringMock,
  decryptString: decryptStringMock,
}));

import { checkGitHubSkillVersionUpdate } from "./updates";

function makeSkillDb(options: { tenantEnabled: boolean }) {
  return makeFakeDb((call: DbCall) => {
    if (call.table === "altien_skill_tenant_settings") {
      return {
        data: [{ github_import_enabled: options.tenantEnabled }],
        error: null,
      };
    }
    if (call.table === "altien_skill_github_connections") {
      return { data: [], error: null };
    }
    if (call.table === "altien_skill_versions") {
      return {
        data: [{ id: "version-1", snapshot_id: "snapshot-1", skill_id: "skill-1" }],
        error: null,
      };
    }
    if (call.table === "altien_skills") {
      return { data: [{ id: "skill-1" }], error: null };
    }
    if (call.table === "altien_skill_import_snapshots") {
      return {
        data: [
          {
            source_kind: "github",
            github_repository: "github.com/example/skills",
            github_selected_path: "legal",
            github_requested_ref: "main",
            github_resolved_commit_sha: "a".repeat(40),
          },
        ],
        error: null,
      };
    }
    return { data: [], error: null };
  });
}

describe("GitHub skill update checks", () => {
  beforeEach(() => {
    process.env.GITHUB_SKILL_OAUTH_CLIENT_ID = "client-id";
    process.env.GITHUB_SKILL_OAUTH_CLIENT_SECRET = "client-secret";
    decryptStringMock.mockReset();
  });

  afterEach(() => {
    delete process.env.GITHUB_SKILL_OAUTH_CLIENT_ID;
    delete process.env.GITHUB_SKILL_OAUTH_CLIENT_SECRET;
    delete process.env.ALLOW_GITHUB_SKILL_IMPORTS;
  });

  it("refuses to contact GitHub when the deployment gate denies acquisition", async () => {
    delete process.env.ALLOW_GITHUB_SKILL_IMPORTS;
    const fake = makeSkillDb({ tenantEnabled: true });
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(
      checkGitHubSkillVersionUpdate({
        tenantId: "tenant-1",
        versionId: "version-1",
        db: fake.db as never,
        fetcher,
      }),
    ).rejects.toThrow("GITHUB_SKILL_IMPORT_DEPLOYMENT_DENIED");
    expect(fetcher).not.toHaveBeenCalled();
    expect(fake.callsFor("altien_skill_import_snapshots")).toHaveLength(0);
  });

  it("refuses to contact GitHub when the tenant has disabled acquisition", async () => {
    process.env.ALLOW_GITHUB_SKILL_IMPORTS = "true";
    const fake = makeSkillDb({ tenantEnabled: false });
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(
      checkGitHubSkillVersionUpdate({
        tenantId: "tenant-1",
        versionId: "version-1",
        db: fake.db as never,
        fetcher,
      }),
    ).rejects.toThrow("GITHUB_SKILL_IMPORT_TENANT_DISABLED");
    expect(fetcher).not.toHaveBeenCalled();
    expect(fake.callsFor("altien_skill_import_snapshots")).toHaveLength(0);
  });

  it("checks the tracked ref when both gates allow acquisition", async () => {
    process.env.ALLOW_GITHUB_SKILL_IMPORTS = "true";
    const fake = makeSkillDb({ tenantEnabled: true });
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ sha: "b".repeat(40) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    await expect(
      checkGitHubSkillVersionUpdate({
        tenantId: "tenant-1",
        versionId: "version-1",
        db: fake.db as never,
        fetcher,
      }),
    ).resolves.toMatchObject({
      repository: "github.com/example/skills",
      requestedRef: "main",
      selectedPath: "legal",
      previousCommitSha: "a".repeat(40),
      currentCommitSha: "b".repeat(40),
      updateAvailable: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toBe(
      "https://api.github.com/repos/example/skills/commits/main",
    );
  });
});
