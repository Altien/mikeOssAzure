import { describe, expect, it, vi } from "vitest";
import { makeFakeDb } from "../../test/helpers/fakeDb";

const { downloadFileMock } = vi.hoisted(() => ({
  downloadFileMock: vi.fn(),
}));

vi.mock("../../lib/storage", () => ({
  downloadFile: downloadFileMock,
}));

import { loadSkillChatRuntimeContext } from "./runtime";

describe("loadSkillChatRuntimeContext", () => {
  it("loads the exact bound version even after later disablement", async () => {
    downloadFileMock.mockResolvedValue(
      new TextEncoder().encode(
        "---\nname: Reader\ndescription: Reads\n---\nRead the selected document.",
      ).buffer,
    );
    const fake = makeFakeDb((call) => {
      if (call.table === "altien_chat_skill_bindings") {
        return {
          data: [
            {
              root_skill_id: "skill-1",
              root_version_id: "version-1",
            },
          ],
          error: null,
        };
      }
      if (call.table === "altien_skill_versions") {
        return {
          data: [
            {
              id: "version-1",
              snapshot_id: "snapshot-1",
              entrypoint_path: "SKILL.md",
              original_content_hash: "content-hash",
              state: "disabled",
              approved_execution_contract: {
                projectRead: true,
                approvedToolNames: ["authority_trace"],
              },
            },
          ],
          error: null,
        };
      }
      if (call.table === "altien_skills") {
        return {
          data: [{ id: "skill-1", display_name: "Reader" }],
          error: null,
        };
      }
      if (call.table === "altien_skill_import_snapshots") {
        return {
          data: [
            {
              manifest: {
                files: [
                  {
                    path: "SKILL.md",
                    document_version_id: "document-version-1",
                  },
                ],
              },
            },
          ],
          error: null,
        };
      }
      if (call.table === "document_versions") {
        return {
          data: [{ storage_path: "skills/version-1.md" }],
          error: null,
        };
      }
      return { data: [], error: null };
    });

    const result = await loadSkillChatRuntimeContext({
      chatId: "chat-1",
      projectId: "project-1",
      db: fake.db as never,
    });

    expect(result).toMatchObject({
      skillId: "skill-1",
      versionId: "version-1",
      contentHash: "content-hash",
      allowedToolNames: expect.arrayContaining([
        "list_documents",
        "fetch_documents",
        "read_document",
        "find_in_document",
        "authority_trace",
      ]),
    });
    expect(result?.systemPrompt).toContain("Read the selected document.");
    expect(result?.systemPrompt).not.toContain("name: Reader");
  });

  it("returns null for an ordinary unbound chat", async () => {
    const fake = makeFakeDb(() => ({ data: [], error: null }));
    await expect(
      loadSkillChatRuntimeContext({
        chatId: "chat-ordinary",
        projectId: "project-1",
        db: fake.db as never,
      }),
    ).resolves.toBeNull();
  });

  it("loads exact dependency instructions, tools, and namespaced resources", async () => {
    downloadFileMock.mockImplementation(async (path: string) =>
      new TextEncoder().encode(
        path.includes("dependency")
          ? "---\nname: Helper\n---\nUse the helper method."
          : "---\nname: Root\n---\nFollow the root method.",
      ).buffer,
    );
    const fake = makeFakeDb((call) => {
      const id = call.filters.find((filter) => filter[1] === "id")?.[2];
      if (call.table === "altien_chat_skill_bindings") {
        return {
          data: [{
            root_skill_id: "skill-root",
            root_version_id: "version-root",
            dependency_versions: [{
              skillId: "skill-dependency",
              canonicalName: "helper",
              displayName: "Helper",
              versionId: "version-dependency",
              contentHash: "hash-dependency",
              executionContract: { approvedToolNames: ["find_in_document"] },
            }],
          }],
          error: null,
        };
      }
      if (call.table === "altien_skill_versions") {
        const dependency = id === "version-dependency";
        return {
          data: [{
            id,
            snapshot_id: dependency ? "snapshot-dependency" : "snapshot-root",
            entrypoint_path: "SKILL.md",
            original_content_hash: dependency ? "hash-dependency" : "hash-root",
            approved_execution_contract: dependency
              ? { approvedToolNames: ["find_in_document"] }
              : { projectRead: false, approvedToolNames: [] },
          }],
          error: null,
        };
      }
      if (call.table === "altien_skills") {
        return { data: [{ id: "skill-root", display_name: "Root" }], error: null };
      }
      if (call.table === "altien_skill_import_snapshots") {
        const dependency = id === "snapshot-dependency";
        return {
          data: [{
            manifest: {
              files: [{
                path: "SKILL.md",
                document_version_id: dependency ? "doc-dependency" : "doc-root",
                inspection_class: "text",
              }],
            },
          }],
          error: null,
        };
      }
      if (call.table === "document_versions") {
        return {
          data: [{
            storage_path:
              id === "doc-dependency"
                ? "skills/dependency.md"
                : "skills/root.md",
          }],
          error: null,
        };
      }
      return { data: [], error: null };
    });

    const result = await loadSkillChatRuntimeContext({
      chatId: "chat-1",
      projectId: "project-1",
      db: fake.db as never,
    });

    expect(result?.systemPrompt).toContain("Follow the root method.");
    expect(result?.systemPrompt).toContain("Use the helper method.");
    expect(result?.systemPrompt).toContain("subordinate to the root skill");
    expect(result?.allowedToolNames).toContain("find_in_document");
    expect(result?.resourceStore.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "dependencies/helper/SKILL.md" }),
      ]),
    );
  });

  // Regression: bindings record the adapted hash when a version was adapted,
  // so the runtime integrity check must compare against the adapted hash too.
  function makeAdaptedDb(storedDependencyAdaptedHash: string) {
    return makeFakeDb((call) => {
      const id = call.filters.find((filter) => filter[1] === "id")?.[2];
      if (call.table === "altien_chat_skill_bindings") {
        return {
          data: [{
            root_skill_id: "skill-root",
            root_version_id: "version-root",
            dependency_versions: [{
              skillId: "skill-dependency",
              canonicalName: "helper",
              displayName: "Helper",
              versionId: "version-dependency",
              contentHash: "adapted-dependency",
              executionContract: {},
            }],
          }],
          error: null,
        };
      }
      if (call.table === "altien_skill_versions") {
        const dependency = id === "version-dependency";
        return {
          data: [{
            id,
            snapshot_id: dependency ? "snapshot-dependency" : "snapshot-root",
            entrypoint_path: "SKILL.md",
            original_content_hash: dependency
              ? "original-dependency"
              : "original-root",
            adapted_content_hash: dependency
              ? storedDependencyAdaptedHash
              : "adapted-root",
            approved_execution_contract: {},
          }],
          error: null,
        };
      }
      if (call.table === "altien_skills") {
        return { data: [{ id: "skill-root", display_name: "Root" }], error: null };
      }
      if (call.table === "altien_skill_import_snapshots") {
        const dependency = id === "snapshot-dependency";
        return {
          data: [{
            manifest: {
              files: [{
                path: "SKILL.md",
                document_version_id: dependency ? "doc-dependency" : "doc-root",
                inspection_class: "text",
              }],
            },
          }],
          error: null,
        };
      }
      if (call.table === "document_versions") {
        return {
          data: [{
            storage_path:
              id === "doc-dependency"
                ? "skills/dependency.md"
                : "skills/root.md",
          }],
          error: null,
        };
      }
      return { data: [], error: null };
    });
  }

  it("accepts an adapted dependency version pinned to the chat", async () => {
    downloadFileMock.mockImplementation(async (path: string) =>
      new TextEncoder().encode(
        path.includes("dependency")
          ? "---\nname: Helper\n---\nUse the helper method."
          : "---\nname: Root\n---\nFollow the root method.",
      ).buffer,
    );
    const fake = makeAdaptedDb("adapted-dependency");

    const result = await loadSkillChatRuntimeContext({
      chatId: "chat-adapted",
      projectId: "project-1",
      db: fake.db as never,
    });

    expect(result?.contentHash).toBe("adapted-root");
    expect(result?.systemPrompt).toContain("Use the helper method.");
  });

  it("rejects a dependency whose stored content was tampered with", async () => {
    downloadFileMock.mockImplementation(async (path: string) =>
      new TextEncoder().encode(
        path.includes("dependency")
          ? "---\nname: Helper\n---\nUse the tampered method."
          : "---\nname: Root\n---\nFollow the root method.",
      ).buffer,
    );
    const fake = makeAdaptedDb("tampered-dependency");

    await expect(
      loadSkillChatRuntimeContext({
        chatId: "chat-adapted",
        projectId: "project-1",
        db: fake.db as never,
      }),
    ).rejects.toThrow("content hash changed");
  });
});
