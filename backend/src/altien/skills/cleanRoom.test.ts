import { describe, expect, it } from "vitest";
import {
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
