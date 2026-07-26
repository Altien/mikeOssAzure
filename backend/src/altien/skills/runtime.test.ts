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
});
