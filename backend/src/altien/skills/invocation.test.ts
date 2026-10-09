import { describe, expect, it } from "vitest";
import { makeFakeDb, type DbCall } from "../../test/helpers/fakeDb";
import {
  bindExplicitSkillInvocation,
  parseExplicitSkillInvocation,
  parseSkillInvocationCandidates,
  resolveSelectedProjectDocuments,
  upgradeChatSkillBinding,
} from "./invocation";

describe("explicit skill invocation", () => {
  it("accepts slash syntax and quoted verb syntax", () => {
    expect(parseExplicitSkillInvocation("/skill Citation Reader\nCheck this.")).toBe(
      "Citation Reader",
    );
    expect(parseExplicitSkillInvocation('use skill "Citation Reader" to check this')).toBe(
      "Citation Reader",
    );
    expect(parseExplicitSkillInvocation('load skill “Citation Reader”')).toBe(
      "Citation Reader",
    );
  });

  it("never infers a skill from ordinary chat language", () => {
    expect(
      parseExplicitSkillInvocation(
        "Could you use the citation reader skill to check this?",
      ),
    ).toBeNull();
    expect(parseExplicitSkillInvocation("use skill Citation Reader")).toBeNull();
  });

  it("offers the natural phrasings as candidates to resolve", () => {
    // The wording a member actually reaches for. None of these mean anything
    // until they match an enabled skill exactly.
    expect(
      parseSkillInvocationCandidates(
        "Use the case-summariser skill to give me good details here",
      ),
    ).toContain("case-summariser");
    expect(
      parseSkillInvocationCandidates("use skill case-summariser"),
    ).toContain("case-summariser");
    expect(parseSkillInvocationCandidates("/skill case-summariser")).toContain(
      "case-summariser",
    );
    expect(parseSkillInvocationCandidates("what can you do?")).toEqual([]);
  });
});

/**
 * One enabled skill ("Reader", version `version-1`) with an optional newer
 * enabled version, an optional project pin, and the chat binding row a test
 * needs. Document ids in `projectDocumentIds` belong to `project-1`.
 */
function makeSkillDb(options: {
  currentVersionId?: string;
  pinnedVersionId?: string;
  binding?: Record<string, unknown> | null;
  projectDocumentIds?: string[];
} = {}) {
  const currentVersionId = options.currentVersionId ?? "version-1";
  return makeFakeDb((call: DbCall) => {
    const id = call.filters.find((filter) => filter[1] === "id")?.[2];
    if (call.table === "altien_chat_skill_bindings" && call.op === "select") {
      return { data: options.binding ? [options.binding] : [], error: null };
    }
    if (call.table === "altien_skills" && call.op === "select") {
      return {
        data: [{
          id: "skill-1",
          canonical_name: "reader",
          display_name: "Reader",
          current_version_id: currentVersionId,
        }],
        error: null,
      };
    }
    if (call.table === "altien_project_skill_pins") {
      return {
        data: options.pinnedVersionId
          ? [{ skill_id: "skill-1", version_id: options.pinnedVersionId }]
          : [],
        error: null,
      };
    }
    if (call.table === "altien_skill_versions" && call.op === "select") {
      return {
        data: [{
          id,
          skill_id: "skill-1",
          state: "enabled",
          original_content_hash: `hash-${String(id)}`,
        }],
        error: null,
      };
    }
    if (call.table === "documents" && call.op === "select") {
      const requested = (call.filters.find((filter) => filter[0] === "in")?.[2] ??
        []) as string[];
      const known = new Set(options.projectDocumentIds ?? []);
      return {
        data: requested.filter((value) => known.has(value)).map((value) => ({
          id: value,
        })),
        error: null,
      };
    }
    return { data: [], error: null };
  });
}

describe("natural-phrasing invocation", () => {
  it("binds when the named skill exists, however the member phrased it", async () => {
    const fake = makeSkillDb();
    await expect(
      bindExplicitSkillInvocation({
        tenantId: "tenant-1",
        projectId: "project-1",
        chatId: "chat-1",
        userId: "user-1",
        message: "Use the reader skill to give me good details here",
        db: fake.db as never,
      }),
    ).resolves.toMatchObject({ versionId: "version-1" });
  });

  it("leaves an ordinary sentence alone rather than failing the message", async () => {
    const fake = makeSkillDb();
    await expect(
      bindExplicitSkillInvocation({
        tenantId: "tenant-1",
        projectId: "project-1",
        chatId: "chat-1",
        userId: "user-1",
        message: "Can you use the new skill I mentioned earlier?",
        db: fake.db as never,
      }),
    ).resolves.toBeNull();
    expect(fake.callsFor("altien_chat_skill_bindings", "insert")).toHaveLength(0);
  });

  it("still reports a bad name when the member clearly meant a skill", async () => {
    const fake = makeSkillDb();
    await expect(
      bindExplicitSkillInvocation({
        tenantId: "tenant-1",
        projectId: "project-1",
        chatId: "chat-1",
        userId: "user-1",
        message: "/skill nope",
        db: fake.db as never,
      }),
    ).rejects.toThrow(/'nope' was not found/);
  });
});

describe("project document selection", () => {
  it("keeps a selection of documents that belong to the run's project", async () => {
    const fake = makeSkillDb({ projectDocumentIds: ["doc-a", "doc-b"] });
    await expect(
      resolveSelectedProjectDocuments({
        projectId: "project-1",
        documentIds: ["doc-a", "doc-b", "doc-a", "  "],
        db: fake.db as never,
      }),
    ).resolves.toEqual(["doc-a", "doc-b"]);
  });

  it("refuses a document that is not in the project", async () => {
    const fake = makeSkillDb({ projectDocumentIds: ["doc-a"] });
    await expect(
      resolveSelectedProjectDocuments({
        projectId: "project-1",
        documentIds: ["doc-a", "doc-from-another-project"],
        db: fake.db as never,
      }),
    ).rejects.toThrow("not available in this project");
  });

  it("treats no selection as the whole-project default", async () => {
    const fake = makeSkillDb();
    await expect(
      resolveSelectedProjectDocuments({
        projectId: "project-1",
        documentIds: [],
        db: fake.db as never,
      }),
    ).resolves.toEqual([]);
    expect(fake.callsFor("documents")).toHaveLength(0);
  });

  it("records the selected documents on the chat binding", async () => {
    const fake = makeSkillDb({ projectDocumentIds: ["doc-a"] });
    const result = await bindExplicitSkillInvocation({
      tenantId: "tenant-1",
      projectId: "project-1",
      chatId: "chat-1",
      userId: "user-1",
      message: "/skill Reader",
      selectedDocumentIds: ["doc-a"],
      db: fake.db as never,
    });

    expect(result).toMatchObject({
      versionId: "version-1",
      selectedDocumentIds: ["doc-a"],
    });
    expect(
      fake.callsFor("altien_chat_skill_bindings", "insert")[0].payload,
    ).toMatchObject({
      root_version_id: "version-1",
      selected_document_ids: ["doc-a"],
    });
  });

  it("does not bind the skill when the selection is invalid", async () => {
    const fake = makeSkillDb({ projectDocumentIds: [] });
    await expect(
      bindExplicitSkillInvocation({
        tenantId: "tenant-1",
        projectId: "project-1",
        chatId: "chat-1",
        userId: "user-1",
        message: "/skill Reader",
        selectedDocumentIds: ["doc-elsewhere"],
        db: fake.db as never,
      }),
    ).rejects.toThrow("not available in this project");
    expect(fake.callsFor("altien_chat_skill_bindings", "insert")).toHaveLength(0);
  });
});

describe("upgradeChatSkillBinding", () => {
  const binding = {
    chat_id: "chat-1",
    tenant_id: "tenant-1",
    project_id: "project-1",
    root_skill_id: "skill-1",
    root_version_id: "version-1",
    dependency_versions: [],
  };

  it("rebinds the chat to the exact newer version the member accepted", async () => {
    const fake = makeSkillDb({ currentVersionId: "version-2", binding });
    const result = await upgradeChatSkillBinding({
      tenantId: "tenant-1",
      projectId: "project-1",
      chatId: "chat-1",
      userId: "user-1",
      toVersionId: "version-2",
      db: fake.db as never,
    });

    expect(result).toMatchObject({
      previousVersionId: "version-1",
      versionId: "version-2",
      contentHash: "hash-version-2",
    });
    const update = fake.callsFor("altien_chat_skill_bindings", "update")[0];
    expect(update.payload).toMatchObject({
      root_version_id: "version-2",
      upgraded_from_version_id: "version-1",
      upgraded_by: "user-1",
    });
  });

  it("refuses a version other than the one currently offered", async () => {
    const fake = makeSkillDb({ currentVersionId: "version-2", binding });
    await expect(
      upgradeChatSkillBinding({
        tenantId: "tenant-1",
        projectId: "project-1",
        chatId: "chat-1",
        userId: "user-1",
        toVersionId: "version-9",
        db: fake.db as never,
      }),
    ).rejects.toThrow("The offered upgrade changed");
    expect(fake.callsFor("altien_chat_skill_bindings", "update")).toHaveLength(0);
  });

  it("refuses when the chat already runs the newest enabled version", async () => {
    const fake = makeSkillDb({ currentVersionId: "version-1", binding });
    await expect(
      upgradeChatSkillBinding({
        tenantId: "tenant-1",
        projectId: "project-1",
        chatId: "chat-1",
        userId: "user-1",
        toVersionId: "version-1",
        db: fake.db as never,
      }),
    ).rejects.toThrow("already at its newest enabled version");
  });

  // Story 34: a project pin decides which version new chats bind to, so an
  // upgrade must land on the pinned version rather than jumping past it.
  it("upgrades to the project-pinned version, not the library's newest", async () => {
    const fake = makeSkillDb({
      currentVersionId: "version-3",
      pinnedVersionId: "version-2",
      binding,
    });
    await expect(
      upgradeChatSkillBinding({
        tenantId: "tenant-1",
        projectId: "project-1",
        chatId: "chat-1",
        userId: "user-1",
        toVersionId: "version-3",
        db: fake.db as never,
      }),
    ).rejects.toThrow("The offered upgrade changed");

    const pinned = makeSkillDb({
      currentVersionId: "version-3",
      pinnedVersionId: "version-2",
      binding,
    });
    await expect(
      upgradeChatSkillBinding({
        tenantId: "tenant-1",
        projectId: "project-1",
        chatId: "chat-1",
        userId: "user-1",
        toVersionId: "version-2",
        db: pinned.db as never,
      }),
    ).resolves.toMatchObject({ versionId: "version-2", pinned: true });
  });

  it("refuses an upgrade for a chat with no skill binding", async () => {
    const fake = makeSkillDb({ binding: null });
    await expect(
      upgradeChatSkillBinding({
        tenantId: "tenant-1",
        projectId: "project-1",
        chatId: "chat-1",
        userId: "user-1",
        toVersionId: "version-2",
        db: fake.db as never,
      }),
    ).rejects.toThrow("not bound to a skill");
  });
});
