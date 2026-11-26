import { describe, expect, it } from "vitest";
import { hydrateDownloadHistory, stripDownloadUrls } from "../downloadHistory";
import { makeFakeDb } from "../../test/helpers/fakeDb";
import type { Db } from "../supabase";
import { createReservedAssistantMessageUpdater } from "../../modules/chat/engine/routeStreaming";

const path = "documents/u/doc/source.pdf";
const oldUrl = "/download/" + Buffer.from(JSON.stringify({ p: path, f: "old.pdf", exp: 1 })).toString("base64url") + ".signature";

describe("token-free chat history", () => {
  it("removes nested credentials without changing stored input", () => {
    const value = [{ content: [{ type: "doc_created", document_id: "doc", version_id: "v", download_url: oldUrl, nested: { download_url: oldUrl } }] }];
    const clean = stripDownloadUrls(value);
    expect(JSON.stringify(clean)).not.toContain("download_url");
    expect(clean[0].content[0]).toMatchObject({ document_id: "doc", version_id: "v", nested: {} });
    expect(value[0].content[0].download_url).toBe(oldUrl);
  });

  it("restores document/version IDs for expired legacy links via live tenant-scoped versions", async () => {
    const fake = makeFakeDb(() => ({ data: [{ id: "v", document_id: "doc", storage_path: path, version_number: 2 }] }));
    const clean = await hydrateDownloadHistory([{ content: [{ type: "doc_download", filename: "old.pdf", download_url: oldUrl }] }], fake.db as unknown as Db);
    expect(clean).toEqual([{ content: [{ type: "doc_download", filename: "old.pdf", document_id: "doc", version_id: "v", version_number: 2 }] }]);
    expect(fake.calls[0]).toMatchObject({ table: "document_versions", filters: [["in", "storage_path", [path]], ["is", "deleted_at", null]] });
  });

  it("drops missing or foreign version links and never revives their credentials", async () => {
    const fake = makeFakeDb(() => ({ data: [] }));
    const clean = await hydrateDownloadHistory({ type: "doc_download", filename: "old.pdf", download_url: oldUrl }, fake.db as unknown as Db);
    expect(clean).toEqual({ type: "doc_download", filename: "old.pdf" });
  });

  it("makes no lookup for complete IDs or an external URL", async () => {
    const fake = makeFakeDb();
    const clean = await hydrateDownloadHistory([{ type: "doc_created", document_id: "doc", version_id: "v", download_url: oldUrl }, { type: "doc_download", download_url: "https://other.test/download/secret" }], fake.db as unknown as Db);
    expect(fake.calls).toEqual([]);
    expect(JSON.stringify(clean)).not.toContain("download_url");
  });

  it("never stores a legacy download_url when updating a reserved assistant turn", async () => {
    const fake = makeFakeDb();
    const update = createReservedAssistantMessageUpdater({ db: fake.db as unknown as Db, table: "chat_messages", id: "m", chatId: "c" });
    expect(await update([{ type: "doc_created", document_id: "doc", version_id: "v", download_url: oldUrl }], [])).toBeNull();
    expect(fake.calls[0].payload).toEqual({ content: [{ type: "doc_created", document_id: "doc", version_id: "v" }], citations: [] });
  });
});
