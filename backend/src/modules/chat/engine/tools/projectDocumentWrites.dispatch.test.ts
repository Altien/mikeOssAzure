import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFakeDb, type DbCall } from "../../../test/helpers/fakeDb";

const { uploadFileMock } = vi.hoisted(() => ({
  uploadFileMock: vi.fn(),
}));

vi.mock("../../storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../storage")>()),
  uploadFile: uploadFileMock,
}));

import { runToolCalls } from "./toolDispatcher";
import type { DocIndex, DocStore } from "../types";

function emptyProject() {
  return makeFakeDb((call: DbCall) =>
    call.op === "select" ? { data: [] } : { data: [] },
  );
}

function call(filename: string, content: string) {
  return {
    id: "write-1",
    function: {
      name: "write_project_document",
      arguments: JSON.stringify({ filename, content }),
    },
  };
}

async function dispatch(
  toolCall: ReturnType<typeof call>,
  options?: { projectId?: string | null },
) {
  const { db, calls } = emptyProject();
  const docStore: DocStore = new Map();
  const docIndex: DocIndex = {};
  const events: string[] = [];
  const result = await runToolCalls(
    [toolCall],
    docStore,
    "user-1",
    db as never,
    (chunk) => events.push(chunk),
    undefined,
    undefined,
    docIndex,
    undefined,
    undefined,
    options && "projectId" in options ? options.projectId : "project-1",
  );
  const payload = JSON.parse(
    String((result.toolResults[0] as { content: string }).content),
  );
  return { payload, events, docStore, docIndex, result, calls };
}

beforeEach(() => {
  uploadFileMock.mockReset().mockResolvedValue(undefined);
});

describe("write_project_document dispatch", () => {
  it("registers the written document so the assistant can read it back", async () => {
    const { payload, events, docStore, docIndex, result } = await dispatch(
      call("cites.json", '{"cites": []}'),
    );

    expect(payload).toMatchObject({
      ok: true,
      created: "new",
      filename: "cites.json",
      bytes: 13,
      doc_id: "doc-0",
      download_url: expect.stringMatching(/^\/download\//),
    });
    // The model gets a download link but never the storage key behind it.
    expect(payload).not.toHaveProperty("storage_path");
    expect(docIndex["doc-0"]).toMatchObject({
      document_id: payload.document_id,
      filename: "cites.json",
    });
    expect(docStore.get("doc-0")).toMatchObject({ file_type: "json" });
    expect(events.join("")).toContain('"doc_created_start"');
    expect(result.docsCreated).toEqual([
      expect.objectContaining({ filename: "cites.json", version_number: 1 }),
    ]);
  });

  it("reports a refusal to the model without announcing a document", async () => {
    const { payload, events, docIndex } = await dispatch(
      call("cites.json", "{}"),
      { projectId: null },
    );

    expect(payload).toMatchObject({ ok: false, error: "no_active_project" });
    expect(events).toEqual([]);
    expect(docIndex).toEqual({});
    expect(uploadFileMock).not.toHaveBeenCalled();
  });
});
