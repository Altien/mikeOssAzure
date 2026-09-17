import { describe, expect, it } from "vitest";
import { makeFakeDb } from "../../test/helpers/fakeDb";
import { buildSystemPrompt } from "./prompts";
import { buildWorkflowStore } from "./contextBuilders";
import { TOOLS } from "./tools/toolSchemas";

// OSS-6 step D flipped both cases: the upstream frontend (AskInputPopup,
// metadata-shaped workflows) is adopted, so ask_inputs is exposed and the
// frozen frontend's legacy workflow-id aliases are gone (0042 backfills
// hidden_workflows).
describe("upstream feature compatibility", () => {
  it("exposes ask_inputs in the tool schema and the system prompt", () => {
    const toolNames = TOOLS.map((tool) => tool.function.name);

    expect(toolNames).toContain("ask_inputs");
    expect(buildSystemPrompt()).toContain("call ask_inputs");
    expect(buildSystemPrompt(false)).toContain("call ask_inputs");
  });

  it("serves only current system workflow ids (no legacy aliases)", async () => {
    const { db } = makeFakeDb();

    const store = await buildWorkflowStore("user-1", null, db as never);

    expect(store.has("builtin-draft-cp-checklist")).toBe(true);
    expect(store.has("builtin-credit-agreement-review")).toBe(true);
    expect(store.has("builtin-shareholder-agreement-review")).toBe(true);
    expect(store.has("builtin-cp-checklist")).toBe(false);
    expect(store.has("builtin-credit-summary")).toBe(false);
    expect(store.has("builtin-sha-summary")).toBe(false);
  });
});
