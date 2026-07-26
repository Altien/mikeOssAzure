import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, type DbCall } from "../../test/helpers/fakeDb";

vi.mock("../../lib/mcp/client", () => ({
  encryptString: vi.fn(),
  decryptString: vi.fn(),
}));

import {
  CLEAN_ROOM_LINKED_SOURCE_LIMITS,
  CLEAN_ROOM_SNAPSHOT_RUN_WORDS,
  collectCleanRoomGitHubSources,
  evaluateCleanRoomLeakage,
  findCleanRoomLeakage,
  findExplicitGitHubSourceLinks,
  generateCleanRoomBrief,
} from "./cleanRoom";

const source = {
  path: "server.ts",
  sha256: "source-hash",
  text: "const distinctiveImplementationSequence = createHiddenTransportWithRetryBudget and then serializeEveryPrivateInternalDetail before returning the secret response payload;",
};

describe("clean-room developer briefs", () => {
  it("produces a behavioural brief without returning executable source", async () => {
    const result = await generateCleanRoomBrief({
      requirementName: "lookup_records",
      provenance: { licencePaths: ["LICENSE"] },
      sources: [source],
      model: "gpt-5.4-lite",
      complete: async () =>
        JSON.stringify({
          title: "Record lookup tool",
          purpose: "Retrieve matching records from an authorized service.",
          inputs: ["A literal query string."],
          outputs: ["A bounded list of records."],
          errorsAndLimits: ["Reject an empty query."],
          sideEffects: ["No mutation."],
          networkAndDataAccess: ["Reads an authorized remote service."],
          securityRequirements: ["Use the current caller authorization."],
          stateAndConcurrency: ["Calls are independent."],
          proposedToolSchema: {
            name: "lookup_records",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
          acceptanceTests: ["An empty query is rejected."],
          unknowns: ["Provider rate limit is unknown."],
        }),
    });
    expect(result.markdown).toContain("HUMAN REVIEW REQUIRED");
    expect(result.markdown).not.toContain("distinctiveImplementationSequence");
    expect(result.markdown).toContain("Linked GitHub sources: none declared");
    expect(result.provenance).toMatchObject({
      provider: "openai",
      model: "gpt-5.4-lite",
    });
  });

  it("blocks source-span leakage", () => {
    const copied =
      "distinctiveImplementationSequence createHiddenTransportWithRetryBudget and then serializeEveryPrivateInternalDetail before returning the secret response payload";
    expect(findCleanRoomLeakage(copied, [source])).toHaveLength(1);
  });
});

describe("evaluateCleanRoomLeakage", () => {
  const implementation = {
    path: "src/transport.ts",
    sha256: "transport-hash",
    text: Array.from(
      { length: 120 },
      (_unused, index) => `implementationToken${index}`,
    ).join(" "),
  };

  it("fails a brief that reproduces a long verbatim span", () => {
    const copied = Array.from(
      { length: CLEAN_ROOM_SNAPSHOT_RUN_WORDS + 5 },
      (_unused, index) => `implementationToken${index}`,
    ).join(" ");
    const result = evaluateCleanRoomLeakage(
      `# Brief\n\n${copied}\n`,
      [implementation],
      { runWords: CLEAN_ROOM_SNAPSHOT_RUN_WORDS },
    );
    expect(result.passed).toBe(false);
    expect(result.violations[0]).toMatchObject({
      path: "src/transport.ts",
      words: CLEAN_ROOM_SNAPSHOT_RUN_WORDS,
    });
  });

  it("passes a behavioural brief that only shares short phrases", () => {
    const brief =
      "# Brief\n\nThe tool returns matching records for a query and rejects an empty query. " +
      "implementationToken1 implementationToken2 implementationToken3 appear only as short quotations.";
    const result = evaluateCleanRoomLeakage(brief, [implementation], {
      runWords: CLEAN_ROOM_SNAPSHOT_RUN_WORDS,
    });
    expect(result).toMatchObject({
      passed: true,
      runWords: CLEAN_ROOM_SNAPSHOT_RUN_WORDS,
      violations: [],
    });
  });
});

describe("explicit github.com source links", () => {
  const linking = {
    path: "mcp/server.ts",
    sha256: "linking-hash",
    text: [
      "// Ported from https://github.com/example/upstream/tree/main/tools.",
      "// See also https://github.com/example/upstream/tree/main/tools (again),",
      '// and the package "left-pad" at https://registry.npmjs.org/left-pad.',
    ].join("\n"),
  };

  function makeGateDb(options: { tenantEnabled: boolean }) {
    return makeFakeDb((call: DbCall) => {
      if (call.table === "altien_skill_tenant_settings") {
        return {
          data: [{ github_import_enabled: options.tenantEnabled }],
          error: null,
        };
      }
      return { data: [], error: null };
    });
  }

  function acquired(text: string) {
    return {
      sourceBytes: new Uint8Array(),
      snapshot: {
        files: [
          {
            relativePath: "tools/index.ts",
            bytes: new TextEncoder().encode(text),
            byteSize: text.length,
            sha256: "upstream-hash",
            mediaType: "text/plain",
            inspectionClass: "source" as const,
          },
          {
            relativePath: "tools/logo.png",
            bytes: new Uint8Array([0xff, 0xd8]),
            byteSize: 2,
            sha256: "binary-hash",
            mediaType: "image/png",
            inspectionClass: "binary" as const,
          },
        ],
        skills: [],
        treeHash: "tree",
        expandedBytes: text.length,
        licencePaths: [],
        warnings: [],
      },
      provenance: {
        repository: "github.com/example/upstream",
        selectedPath: "tools",
        requestedRef: "main",
        resolvedCommitSha: "c".repeat(40),
        private: false,
      },
    };
  }

  afterEach(() => {
    delete process.env.ALLOW_GITHUB_SKILL_IMPORTS;
  });

  it("finds only whole github.com links written literally in the source", () => {
    expect(findExplicitGitHubSourceLinks([linking])).toEqual([
      "https://github.com/example/upstream/tree/main/tools",
    ]);
    expect(
      findExplicitGitHubSourceLinks([
        { path: "a.ts", sha256: "a", text: "see the example/upstream repo" },
      ]),
    ).toEqual([]);
  });

  it("skips silently with a recorded note when the deployment gate is off", async () => {
    delete process.env.ALLOW_GITHUB_SKILL_IMPORTS;
    const acquire = vi.fn();
    const result = await collectCleanRoomGitHubSources({
      tenantId: "tenant-1",
      sources: [linking],
      db: makeGateDb({ tenantEnabled: true }).db as never,
      acquire: acquire as never,
    });

    expect(acquire).not.toHaveBeenCalled();
    expect(result.sources).toEqual([]);
    expect(result.notes).toEqual([
      {
        url: "https://github.com/example/upstream/tree/main/tools",
        status: "skipped_gate_denied",
        detail: "GITHUB_SKILL_IMPORT_DEPLOYMENT_DENIED",
      },
    ]);
  });

  it("skips silently when the tenant has not enabled acquisition", async () => {
    process.env.ALLOW_GITHUB_SKILL_IMPORTS = "true";
    const acquire = vi.fn();
    const result = await collectCleanRoomGitHubSources({
      tenantId: "tenant-1",
      sources: [linking],
      db: makeGateDb({ tenantEnabled: false }).db as never,
      acquire: acquire as never,
    });

    expect(acquire).not.toHaveBeenCalled();
    expect(result.notes[0]).toMatchObject({
      status: "skipped_gate_denied",
      detail: "GITHUB_SKILL_IMPORT_TENANT_DISABLED",
    });
  });

  it("never reads policy or contacts GitHub when no link is declared", async () => {
    process.env.ALLOW_GITHUB_SKILL_IMPORTS = "true";
    const fake = makeGateDb({ tenantEnabled: true });
    const acquire = vi.fn();
    const result = await collectCleanRoomGitHubSources({
      tenantId: "tenant-1",
      sources: [{ path: "a.ts", sha256: "a", text: "no links here" }],
      db: fake.db as never,
      acquire: acquire as never,
    });

    expect(result).toEqual({ sources: [], notes: [] });
    expect(acquire).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
  });

  it("follows an allowed link through the gated service into the leakage corpus", async () => {
    process.env.ALLOW_GITHUB_SKILL_IMPORTS = "true";
    const acquire = vi.fn(async () => acquired("upstream implementation text"));
    const result = await collectCleanRoomGitHubSources({
      tenantId: "tenant-1",
      sources: [linking],
      db: makeGateDb({ tenantEnabled: true }).db as never,
      acquire: acquire as never,
    });

    expect(acquire).toHaveBeenCalledWith({
      url: "https://github.com/example/upstream/tree/main/tools",
      token: undefined,
      fetcher: undefined,
    });
    expect(result.sources).toEqual([
      {
        path: `github.com/example/upstream@${"c".repeat(40)}/tools/index.ts`,
        sha256: "upstream-hash",
        text: "upstream implementation text",
      },
    ]);
    expect(result.notes[0]).toMatchObject({
      status: "fetched",
      repository: "github.com/example/upstream",
      commitSha: "c".repeat(40),
      fileCount: 1,
    });
  });

  it("bounds the number of links it follows and reports the rest", async () => {
    process.env.ALLOW_GITHUB_SKILL_IMPORTS = "true";
    const many = {
      path: "server.ts",
      sha256: "many",
      text: Array.from(
        { length: CLEAN_ROOM_LINKED_SOURCE_LIMITS.links + 2 },
        (_unused, index) => `https://github.com/example/repo${index}`,
      ).join("\n"),
    };
    const acquire = vi.fn(async () => acquired("upstream text"));
    const result = await collectCleanRoomGitHubSources({
      tenantId: "tenant-1",
      sources: [many],
      db: makeGateDb({ tenantEnabled: true }).db as never,
      acquire: acquire as never,
    });

    expect(acquire).toHaveBeenCalledTimes(CLEAN_ROOM_LINKED_SOURCE_LIMITS.links);
    expect(
      result.notes.filter((note) => note.status === "skipped_link_budget"),
    ).toHaveLength(2);
  });

  it("records an unavailable link instead of failing the brief", async () => {
    process.env.ALLOW_GITHUB_SKILL_IMPORTS = "true";
    const acquire = vi.fn(async () => {
      throw new Error("GitHub repository or ref was not found.");
    });
    const result = await collectCleanRoomGitHubSources({
      tenantId: "tenant-1",
      sources: [linking],
      db: makeGateDb({ tenantEnabled: true }).db as never,
      acquire: acquire as never,
    });

    expect(result.sources).toEqual([]);
    expect(result.notes[0]).toMatchObject({ status: "unavailable" });
  });

  it("refuses a link form the acquisition service does not accept", async () => {
    process.env.ALLOW_GITHUB_SKILL_IMPORTS = "true";
    const acquire = vi.fn();
    const result = await collectCleanRoomGitHubSources({
      tenantId: "tenant-1",
      sources: [{
        path: "server.ts",
        sha256: "blob",
        text: "https://github.com/example/upstream/blob/main/tools/index.ts",
      }],
      db: makeGateDb({ tenantEnabled: true }).db as never,
      acquire: acquire as never,
    });

    expect(acquire).not.toHaveBeenCalled();
    expect(result.notes[0]).toMatchObject({
      status: "skipped_unsupported_link",
    });
  });
});
