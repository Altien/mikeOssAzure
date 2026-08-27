import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAssistantPlaybookContext,
  deletePlaybook,
  ensurePlaybookSchema,
  getPlaybook,
  listPlaybooks,
  normalizeCompiledPlaybookOutput,
  playbookCompilationTimeoutMs,
  playbookImportFailureMessage,
  playbookModelAvailability,
  playbookContentSchema,
  publishPlaybook,
  updatePlaybookDraft,
  validatePlaybookCompilationWithRetry,
} from "../playbooks";
import { createServerSQLite } from "../sqlite";
import { DEFAULT_USER_FEATURES } from "../userFeatures";

const created: Array<{ id: string; userId: string }> = [];

function content(name = "Commercial Playbook") {
  return {
    name,
    description: "Standard commercial positions",
    globalGuidance: "Protect the customer.",
    representedParty: "Customer",
    documentTypes: ["MSA"],
    jurisdictions: ["New York"],
    topics: [{
      id: "liability",
      name: "Liability",
      rules: [{
        id: "liability-cap",
        name: "Liability cap",
        concept: "Determine whether liability is capped.",
        scope: "clause" as const,
        required: true,
        guidance: "Escalate uncapped liability.",
        standard: { name: "Standard", criteria: "Cap at fees paid in 12 months.", sampleClauses: [{ text: "Liability will not exceed fees paid in the preceding 12 months.", usage: "preferred" as const, sourceRefs: [] }] },
        fallbacks: [], unacceptable: [], conditions: [], actions: [], sourceRefs: [],
      }],
    }],
  };
}

async function seed(userId: string) {
  ensurePlaybookSchema();
  const db = createServerSQLite();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const draft = playbookContentSchema.parse(content());
  const result = await db.from("playbooks").insert({ id, user_id: userId, name: draft.name, description: draft.description, status: "draft", draft_json: draft, published_version_id: null, source_filename: null, source_storage_key: null, source_structure_json: null, import_model: null, created_at: now, updated_at: now });
  if (result.error) throw result.error;
  created.push({ id, userId });
  return id;
}

afterEach(async () => {
  const db = createServerSQLite();
  for (const item of created.splice(0)) {
    await db.from("playbook_runs").delete().eq("playbook_id", item.id);
    await db.from("playbook_versions").delete().eq("playbook_id", item.id);
    await db.from("playbooks").delete().eq("id", item.id);
  }
});

describe("playbook persistence", () => {
  it("normalizes model-generated condition objects into readable strings", () => {
    const raw = content();
    raw.topics[0].rules[0].conditions = [
      {
        when: "The supplier processes personal data",
        requirement: "A data processing addendum is required",
      } as unknown as string,
    ];

    const parsed = playbookContentSchema.parse(
      normalizeCompiledPlaybookOutput(raw),
    );

    expect(parsed.topics[0].rules[0].conditions).toEqual([
      "When: The supplier processes personal data; Requirement: A data processing addendum is required",
    ]);
  });

  it("automatically retries a playbook compilation that is not structured JSON", async () => {
    const retry = async (validationError: string) => {
      expect(validationError).toMatch(/structured JSON/i);
      const repaired = content();
      repaired.topics[0].rules[0].sourceRefs = ["P1"];
      return JSON.stringify(repaired);
    };

    const parsed = await validatePlaybookCompilationWithRetry({
      raw: "I was unable to complete the requested JSON.",
      structure: {
        format: "docx",
        blocks: [{
          kind: "paragraph",
          sourceRef: "P1",
          text: "Liability is capped at fees paid in the prior 12 months.",
          style: null,
          level: null,
        }],
        sources: [{
          id: "P1",
          kind: "paragraph",
          text: "Liability is capped at fees paid in the prior 12 months.",
          style: null,
          level: null,
        }],
        text: "[P1] Liability is capped at fees paid in the prior 12 months.",
      },
      retry,
    });

    expect(parsed.name).toBe("Commercial Playbook");
    expect(parsed.topics[0].rules[0].sourceRefs).toEqual(["P1"]);
  });

  it("reports a clear error when both compilation attempts are invalid", async () => {
    await expect(validatePlaybookCompilationWithRetry({
      raw: "not JSON",
      structure: { format: "docx", blocks: [], sources: [], text: "" },
      retry: async () => "still not JSON",
    })).rejects.toThrow(/invalid structured output twice/i);
  });

  it("turns compilation timeouts into an actionable import error", () => {
    const timeout = Object.assign(
      new Error("The operation was aborted due to timeout"),
      { name: "TimeoutError" },
    );
    expect(playbookImportFailureMessage("compiling", timeout, 300_000)).toBe(
      "The selected model did not finish within 5 minutes. Try again or select another model.",
    );
  });

  it("uses a longer configurable timeout for playbook compilation", () => {
    expect(playbookCompilationTimeoutMs("")).toBe(300_000);
    expect(playbookCompilationTimeoutMs("600000")).toBe(600_000);
    expect(playbookCompilationTimeoutMs("invalid")).toBe(300_000);
  });

  it("accepts dynamic OpenRouter and Ollama models when their requirements are met", () => {
    expect(
      playbookModelAvailability(
        "openrouter/anthropic/claude-sonnet-4",
        { openrouter: "sk-or-user" },
        DEFAULT_USER_FEATURES,
      ),
    ).toEqual({ available: true });
    expect(
      playbookModelAvailability(
        "openrouter/anthropic/claude-sonnet-4",
        {},
        DEFAULT_USER_FEATURES,
      ),
    ).toMatchObject({
      available: false,
      reason: expect.stringMatching(/OpenRouter API key/i),
    });
    expect(
      playbookModelAvailability(
        "ollama/qwen3.6",
        {},
        DEFAULT_USER_FEATURES,
      ),
    ).toEqual({ available: true });
  });

  it("updates a draft and publishes immutable numbered versions", async () => {
    const userId = crypto.randomUUID();
    const id = await seed(userId);
    const updated = await updatePlaybookDraft(userId, id, content("Updated Playbook"));
    expect(updated.name).toBe("Updated Playbook");
    expect(updated.status).toBe("draft");

    const first = await publishPlaybook(userId, id);
    expect(first).toMatchObject({ status: "published", publishedVersionNumber: 1 });
    const second = await publishPlaybook(userId, id);
    expect(second).toMatchObject({ status: "published", publishedVersionNumber: 2 });
    expect(second.publishedVersionId).not.toBe(first.publishedVersionId);
    expect((await listPlaybooks(userId)).map((item) => item.id)).toContain(id);
  });

  it("enforces ownership and removes associated versions", async () => {
    const userId = crypto.randomUUID();
    const id = await seed(userId);
    await expect(getPlaybook("another-user", id)).rejects.toThrow(/not found/i);
    await publishPlaybook(userId, id);
    await deletePlaybook(userId, id);
    created.splice(created.findIndex((item) => item.id === id), 1);
    await expect(getPlaybook(userId, id)).rejects.toThrow(/not found/i);
    const db = createServerSQLite();
    const versions = await db.from("playbook_versions").select("id").eq("playbook_id", id);
    expect(versions.data).toEqual([]);
  });

  it("rejects empty playbooks and invalid clause usage", () => {
    expect(() => playbookContentSchema.parse({ ...content(), topics: [] })).toThrow();
    const invalid = content();
    invalid.topics[0].rules[0].standard!.sampleClauses[0].usage = "sometimes" as "preferred";
    expect(() => playbookContentSchema.parse(invalid)).toThrow();
  });

  it("builds Assistant context from the immutable published version", async () => {
    const userId = crypto.randomUUID();
    const id = await seed(userId);
    const first = await publishPlaybook(userId, id);
    await updatePlaybookDraft(userId, id, content("Unpublished Revision"));
    await publishPlaybook(userId, id);

    const context = await buildAssistantPlaybookContext(
      userId,
      id,
      createServerSQLite(),
      first.publishedVersionId!,
    );

    expect(context.prompt).toContain("ACTIVE PUBLISHED PLAYBOOK");
    expect(context.prompt).toContain("Commercial Playbook");
    expect(context.prompt).toContain("version 1");
    expect(context.prompt).toContain("A playbook is not a workflow");
    expect(context.prompt).toContain("never call list_workflows or read_workflow");
    expect(context.prompt).toContain("Cap at fees paid in 12 months.");
    expect(context.prompt).not.toContain("Unpublished Revision");
    expect(context.selection).toEqual({
      id,
      title: "Commercial Playbook",
      version: 1,
      versionId: expect.any(String),
    });
  });

  it("does not expose drafts to Assistant", async () => {
    const userId = crypto.randomUUID();
    const id = await seed(userId);
    await expect(buildAssistantPlaybookContext(userId, id)).rejects.toThrow(
      /publish the playbook/i,
    );
  });
});
