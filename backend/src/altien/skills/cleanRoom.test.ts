import { describe, expect, it } from "vitest";
import {
  CLEAN_ROOM_SNAPSHOT_RUN_WORDS,
  evaluateCleanRoomLeakage,
  findCleanRoomLeakage,
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
