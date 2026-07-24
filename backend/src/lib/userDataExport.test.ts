import { describe, it, expect } from "vitest";
import { makeFakeDb, type DbCall } from "../test/helpers/fakeDb";
import {
  userExportFilename,
  buildUserChatsExport,
  buildUserTabularReviewsExport,
  buildUserAccountExport,
} from "./userDataExport";

function rangeStart(call: DbCall): number | undefined {
  const r = call.filters.find(([m]) => m === "range");
  return r ? Number(r[1]) : undefined;
}

describe("userExportFilename", () => {
  it("embeds the kind, a truncated user id, and a filesystem-safe timestamp", () => {
    const name = userExportFilename("chats", "0123456789abcdef");

    expect(name).toMatch(/^mike-chats-export-01234567-/);
    expect(name).toMatch(/\.json$/);
    // ISO timestamp has its ':' and '.' replaced — the only remaining dot
    // is the extension's. Safe for Content-Disposition filenames.
    expect(name).not.toContain(":");
    expect(name.match(/\./g)).toHaveLength(1);
  });
});

describe("buildUserChatsExport", () => {
  it("exports assistant + tabular chats with their messages, keyed to the user", async () => {
    const { db } = makeFakeDb((call) => {
      if (call.table === "chats") return { data: [{ id: "c1", title: "T" }] };
      if (call.table === "chat_messages")
        return { data: [{ id: "m1", chat_id: "c1" }] };
      if (call.table === "tabular_review_chats")
        return { data: [{ id: "tc1" }] };
      if (call.table === "tabular_review_chat_messages")
        return { data: [{ id: "tm1", chat_id: "tc1" }] };
      return {};
    });

    const out = await buildUserChatsExport(db as never, "u1", "u@x.com");

    expect(out.user).toEqual({ id: "u1", email: "u@x.com" });
    expect(out.assistant_chats).toEqual({
      chats: [{ id: "c1", title: "T" }],
      messages: [{ id: "m1", chat_id: "c1" }],
    });
    expect(out.tabular_review_chats).toEqual({
      chats: [{ id: "tc1" }],
      messages: [{ id: "tm1", chat_id: "tc1" }],
    });
    expect(typeof out.exported_at).toBe("string");
  });

  it("skips the message query entirely when the user has no chats", async () => {
    const { db, callsFor } = makeFakeDb();

    const out = await buildUserChatsExport(db as never, "u1");

    expect(out.user.email).toBeNull();
    expect(out.assistant_chats).toEqual({ chats: [], messages: [] });
    expect(callsFor("chat_messages")).toEqual([]);
  });

  it("pages through results 1000 at a time until a short page arrives", async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({ id: `c${i}` }));
    const { db, callsFor } = makeFakeDb((call) => {
      if (call.table === "chats") {
        return rangeStart(call) === 0
          ? { data: fullPage }
          : { data: [{ id: "c-last" }] };
      }
      if (call.table === "chat_messages") return { data: [] };
      return {};
    });

    const out = await buildUserChatsExport(db as never, "u1");

    expect(out.assistant_chats.chats).toHaveLength(1001);
    const chatSelects = callsFor("chats", "select");
    expect(chatSelects.map(rangeStart)).toEqual([0, 1000]);
  });
});

describe("buildUserTabularReviewsExport", () => {
  it("exports reviews with cells, chats, and messages", async () => {
    const { db } = makeFakeDb((call) => {
      if (call.table === "tabular_reviews") return { data: [{ id: "r1" }] };
      if (call.table === "tabular_cells")
        return { data: [{ id: "cell1", review_id: "r1" }] };
      if (call.table === "tabular_review_chats")
        return { data: [{ id: "tc1", review_id: "r1" }] };
      if (call.table === "tabular_review_chat_messages")
        return { data: [{ id: "tm1" }] };
      return {};
    });

    const out = await buildUserTabularReviewsExport(db as never, "u1", "u@x.com");

    expect(out.tabular_reviews).toEqual([{ id: "r1" }]);
    expect(out.tabular_cells).toEqual([{ id: "cell1", review_id: "r1" }]);
    expect(out.tabular_review_chats).toEqual({
      chats: [{ id: "tc1", review_id: "r1" }],
      messages: [{ id: "tm1" }],
    });
  });
});

describe("buildUserAccountExport", () => {
  it("exports the adopted Library folder hierarchy for the user", async () => {
    const { db, callsFor } = makeFakeDb((call) =>
      call.table === "library_folders"
        ? {
            data: [
              {
                id: "folder-1",
                user_id: "u1",
                name: "Authorities",
                parent_folder_id: null,
              },
            ],
          }
        : {},
    );

    const out = await buildUserAccountExport(db as never, "u1", null);

    expect(out.library_folders).toEqual([
      {
        id: "folder-1",
        user_id: "u1",
        name: "Authorities",
        parent_folder_id: null,
      },
    ]);
    const folderSelect = callsFor("library_folders", "select");
    expect(folderSelect).toHaveLength(1);
    expect(
      folderSelect[0].filters.find(
        ([method, column]) => method === "eq" && column === "user_id",
      )?.[2],
    ).toBe("u1");
  });

  it("includes shares-with-me and shared-with-me scans only when an email is present", async () => {
    const { db: withEmailDb, calls: withEmailCalls } = makeFakeDb();
    await buildUserAccountExport(withEmailDb as never, "u1", "u@x.com");

    const recipientShareScan = withEmailCalls.filter(
      (c) =>
        c.table === "workflow_shares" &&
        c.filters.some(([, col]) => col === "shared_with_email"),
    );
    const sharedWithScans = withEmailCalls.filter((c) =>
      c.filters.some(([m]) => m.startsWith("filter")),
    );
    expect(recipientShareScan).toHaveLength(1);
    // projects + tabular_reviews shared_with containment scans.
    expect(sharedWithScans.map((c) => c.table).sort()).toEqual([
      "projects",
      "tabular_reviews",
    ]);

    const { db: noEmailDb, calls: noEmailCalls } = makeFakeDb();
    await buildUserAccountExport(noEmailDb as never, "u1", null);

    expect(
      noEmailCalls.filter((c) =>
        c.filters.some(([, col]) => col === "shared_with_email"),
      ),
    ).toEqual([]);
    expect(
      noEmailCalls.filter((c) => c.filters.some(([m]) => m.startsWith("filter"))),
    ).toEqual([]);
    // Do not query the deferred workflow-submissions table: it is absent from
    // dev's numbered migrations until the complete feature is adopted.
    expect(
      noEmailCalls.filter(
        (c) => c.table === "workflow_open_source_submissions",
      ),
    ).toEqual([]);
  });

  it("reports API keys as booleans only — never selects key material", async () => {
    const { db, callsFor } = makeFakeDb((call) =>
      call.table === "user_api_keys"
        ? {
            data: [
              { provider: "claude", created_at: "c", updated_at: "u" },
            ],
          }
        : {},
    );

    const out = await buildUserAccountExport(db as never, "u1", null);

    expect(out.api_keys).toEqual([
      { provider: "claude", has_key: true, created_at: "c", updated_at: "u" },
    ]);
    const keySelect = callsFor("user_api_keys", "select")[0];
    expect(keySelect.columns).toBe("provider, created_at, updated_at");
    expect(keySelect.columns).not.toContain("encrypted");
  });
});
