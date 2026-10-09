import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, type DbCall } from "../../test/helpers/fakeDb";

vi.mock("../../lib/mcp/client", () => ({
  encryptString: vi.fn(),
  decryptString: vi.fn(),
}));

import { hashActionPayload } from "./actions";
import {
  CLEAN_ROOM_GENERATOR_RUN_WORDS,
  CLEAN_ROOM_LINKED_SOURCE_LIMITS,
  CLEAN_ROOM_LINK_NOTE_DETAILS,
  CLEAN_ROOM_SNAPSHOT_RUN_WORDS,
  collectCleanRoomGitHubSources,
  evaluateCleanRoomLeakage,
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

  it("specifies only the behaviours nothing here performs", async () => {
    // The real case: four bundled scripts, three of which already have Mike
    // tools. Told only the requirement's name, the generator specifies all
    // four and the one genuine gap arrives buried in redundant work — which
    // is also how somebody ends up rebuilding extract_document_for_verification.
    let systemPrompt = "";
    let user = "";
    const result = await generateCleanRoomBrief({
      requirementName:
        "Local shell with python3 (verify_anchors.py, extract_docx.py, mark_pdf_pages.py, build_review.py)",
      provenance: { licencePaths: [] },
      sources: [source],
      coverage: {
        covered: [
          { label: "extract_docx.py", toolNames: ["extract_document_for_verification"] },
          { label: "mark_pdf_pages.py", toolNames: ["extract_document_for_verification"] },
          { label: "build_review.py", toolNames: ["write_project_document"] },
        ],
        uncovered: [
          {
            label: "verify_anchors.py",
            intent: "Confirms each quoted span still appears at its anchor.",
          },
        ],
      },
      model: "gpt-5.4-lite",
      complete: (async (call: { systemPrompt: string; user: string }) => {
        systemPrompt = call.systemPrompt;
        user = call.user;
        return JSON.stringify({
          title: "Anchor verification tool",
          purpose: "Confirm a quoted span still appears where it is cited.",
          inputs: ["A quoted span and its anchor."],
          outputs: ["Whether the span still matches."],
          errorsAndLimits: ["Reject an empty span."],
          sideEffects: ["No mutation."],
          networkAndDataAccess: ["Reads project documents only."],
          securityRequirements: ["Use the current caller authorization."],
          stateAndConcurrency: ["Calls are independent."],
          proposedToolSchema: { name: "verify_anchors" },
          acceptanceTests: ["A moved span is reported as unmatched."],
          unknowns: ["Tolerance for whitespace drift is unknown."],
        });
      }) as never,
    });

    expect(systemPrompt).toContain("verify_anchors.py");
    expect(systemPrompt).toContain("Do not specify these");
    expect(systemPrompt).toContain("extract_document_for_verification");
    const sent = JSON.parse(user) as {
      specifyOnly: { label: string }[];
      alreadyProvided: { label: string }[];
    };
    expect(sent.specifyOnly.map((atom) => atom.label)).toEqual([
      "verify_anchors.py",
    ]);
    expect(sent.alreadyProvided.map((atom) => atom.label)).toEqual([
      "extract_docx.py",
      "mark_pdf_pages.py",
      "build_review.py",
    ]);
    // The reader has to be able to see what was deliberately left out, or a
    // scoped brief reads as an incomplete one.
    expect(result.markdown).toContain("## Scope");
    expect(result.markdown).toContain("**Specified here** — verify_anchors.py");
    expect(result.markdown).toContain(
      "Already provided by extract_document_for_verification — extract_docx.py",
    );
  });

  it("specifies the whole requirement when nothing is covered", async () => {
    let systemPrompt = "";
    const result = await generateCleanRoomBrief({
      requirementName: "verify_anchors.py",
      provenance: { licencePaths: [] },
      sources: [source],
      coverage: {
        covered: [],
        uncovered: [{ label: "verify_anchors.py", intent: "Checks anchors." }],
      },
      model: "gpt-5.4-lite",
      complete: (async (call: { systemPrompt: string }) => {
        systemPrompt = call.systemPrompt;
        return JSON.stringify({
          title: "Anchor verification tool",
          purpose: "Confirm a quoted span still appears where it is cited.",
          inputs: ["A span."],
          outputs: ["A verdict."],
          errorsAndLimits: ["Reject an empty span."],
          sideEffects: ["No mutation."],
          networkAndDataAccess: ["Reads project documents only."],
          securityRequirements: ["Caller authorization."],
          stateAndConcurrency: ["Independent."],
          proposedToolSchema: { name: "verify_anchors" },
          acceptanceTests: ["A moved span is unmatched."],
          unknowns: ["None."],
        });
      }) as never,
    });
    expect(systemPrompt).not.toContain("Do not specify these");
    expect(result.markdown).not.toContain("## Scope");
  });

  it("blocks source-span leakage", () => {
    const copied =
      "distinctiveImplementationSequence createHiddenTransportWithRetryBudget and then serializeEveryPrivateInternalDetail before returning the secret response payload";
    const result = evaluateCleanRoomLeakage(copied, [source], {
      runWords: CLEAN_ROOM_GENERATOR_RUN_WORDS,
    });
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
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

  function makeGateDb(options: {
    tenantEnabled: boolean;
    /** A stored tenant OAuth connection the clean-room path must not use. */
    oauthConnected?: boolean;
  }) {
    return makeFakeDb((call: DbCall) => {
      if (call.table === "altien_skill_tenant_settings") {
        return {
          data: [{ github_import_enabled: options.tenantEnabled }],
          error: null,
        };
      }
      if (call.table === "altien_skill_github_connections") {
        return {
          data: options.oauthConnected
            ? [{
                encrypted_access_token: "cipher",
                access_token_iv: "iv",
                access_token_tag: "tag",
              }]
            : [],
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
        detail: CLEAN_ROOM_LINK_NOTE_DETAILS.deploymentDenied,
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
      detail: CLEAN_ROOM_LINK_NOTE_DETAILS.tenantDisabled,
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

  // Security: the links come from uploaded skill content, so authenticating
  // the fetch with the tenant's repo-scoped OAuth token would let an uploaded
  // archive pull private-repository text into the leakage corpus, or probe
  // which private repositories exist. The fetch stays anonymous even when the
  // tenant has a connection stored.
  it("never spends the tenant OAuth token on a content-declared link", async () => {
    process.env.ALLOW_GITHUB_SKILL_IMPORTS = "true";
    const fake = makeGateDb({ tenantEnabled: true, oauthConnected: true });
    const acquire = vi.fn(async () => acquired("upstream implementation text"));
    await collectCleanRoomGitHubSources({
      tenantId: "tenant-1",
      sources: [linking],
      db: fake.db as never,
      acquire: acquire as never,
    });

    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({ token: undefined }),
    );
    // The policy read touches the connection row for its metadata; the stored
    // token itself is never even selected, let alone decrypted.
    expect(
      fake.calls.filter((call) =>
        String(call.columns ?? "").includes("encrypted_access_token"),
      ),
    ).toHaveLength(0);
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

  // A private repository, a deleted one, and a transport failure must be
  // indistinguishable in the note, and the upstream error text must never
  // reach the note at all — it flows into the generator prompt.
  it("records an unavailable link with a fixed phrase, not the upstream error", async () => {
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
    expect(result.notes[0]).toEqual({
      url: "https://github.com/example/upstream/tree/main/tools",
      status: "unavailable",
      detail: CLEAN_ROOM_LINK_NOTE_DETAILS.unavailable,
    });
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
    expect(result.notes[0]).toEqual({
      url: "https://github.com/example/upstream/blob/main/tools/index.ts",
      status: "skipped_unsupported_link",
      detail: CLEAN_ROOM_LINK_NOTE_DETAILS.unsupportedLink,
    });
  });

  // Regression: a fetched note used to carry `selectedPath: … || undefined`.
  // `canonicalJson` emitted an `undefined` token at generation time while the
  // jsonb round-trip dropped the key, so the approval hash recomputed from the
  // stored row never matched and every such approval was refused.
  it("hashes a fetched note identically before and after a jsonb round-trip", async () => {
    process.env.ALLOW_GITHUB_SKILL_IMPORTS = "true";
    const acquire = vi.fn(async () => {
      const value = acquired("upstream implementation text");
      return { ...value, provenance: { ...value.provenance, selectedPath: "" } };
    });
    const result = await collectCleanRoomGitHubSources({
      tenantId: "tenant-1",
      sources: [linking],
      db: makeGateDb({ tenantEnabled: true }).db as never,
      acquire: acquire as never,
    });

    const note = result.notes[0];
    expect(note.status).toBe("fetched");
    expect(Object.keys(note)).not.toContain("selectedPath");
    const provenance = { linkedGitHubSources: result.notes };
    expect(hashActionPayload(provenance)).toBe(
      hashActionPayload(JSON.parse(JSON.stringify(provenance))),
    );
    // …and an explicitly undefined optional key hashes the same as an absent one.
    expect(
      hashActionPayload({ ...provenance, model: undefined }),
    ).toBe(hashActionPayload(provenance));
  });
});
