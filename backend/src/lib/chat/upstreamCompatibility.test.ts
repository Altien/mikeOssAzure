import { describe, expect, it } from "vitest";
import { makeFakeDb } from "../../test/helpers/fakeDb";
import { buildSystemPrompt } from "./prompts";
import { buildWorkflowStore } from "./contextBuilders";
import { TOOLS } from "./tools/toolSchemas";

describe("upstream feature compatibility", () => {
  it("does not expose ask_inputs while its frontend interaction is deferred", () => {
    const toolNames = TOOLS.map((tool) => tool.function.name);

    expect(toolNames).not.toContain("ask_inputs");
    expect(buildSystemPrompt()).not.toContain("ask_inputs");
  });

  it("keeps the frozen frontend's assistant workflow ids readable", async () => {
    const { db } = makeFakeDb();

    const store = await buildWorkflowStore("user-1", null, db as never);

    expect(store.has("builtin-cp-checklist")).toBe(true);
    expect(store.has("builtin-credit-summary")).toBe(true);
    expect(store.has("builtin-sha-summary")).toBe(true);
  });
});
