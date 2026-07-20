import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeDb, type DbCall } from "../test/helpers/fakeDb";

const { deleteFileMock, listFilesMock } = vi.hoisted(() => ({
  deleteFileMock: vi.fn(),
  listFilesMock: vi.fn(),
}));

vi.mock("./storage", () => ({
  deleteFile: deleteFileMock,
  listFiles: listFilesMock,
}));

import {
  deleteAllUserChats,
  deleteAllUserTabularReviews,
  deleteUserProjects,
  deleteUserAccountData,
} from "./userDataCleanup";

beforeEach(() => {
  deleteFileMock.mockReset();
  deleteFileMock.mockResolvedValue(undefined);
  listFilesMock.mockReset();
  listFilesMock.mockResolvedValue([]);
});

function filterValue(call: DbCall, method: string, column: string) {
  return call.filters.find(
    ([m, c]) => (m === method || m.startsWith(method)) && c === column,
  )?.[2];
}

describe("deleteAllUserChats", () => {
  it("deletes assistant + tabular chats scoped to the user", async () => {
    const { db, callsFor } = makeFakeDb();

    await deleteAllUserChats(db as never, "u1");

    for (const table of ["chats", "tabular_review_chats"]) {
      const del = callsFor(table, "delete");
      expect(del).toHaveLength(1);
      expect(filterValue(del[0], "eq", "user_id")).toBe("u1");
    }
  });

  it("throws with context when one delete fails", async () => {
    const { db } = makeFakeDb((call) =>
      call.table === "tabular_review_chats"
        ? { error: { message: "deadlock" } }
        : {},
    );

    await expect(deleteAllUserChats(db as never, "u1")).rejects.toThrow(
      "Failed to delete tabular chats: deadlock",
    );
  });
});

describe("deleteAllUserTabularReviews", () => {
  it("cascades messages → chats → cells → reviews and returns the review count", async () => {
    const { db, calls, callsFor } = makeFakeDb((call) => {
      if (call.table === "tabular_reviews" && call.op === "select")
        return { data: [{ id: "r1" }, { id: "r2" }] };
      if (call.table === "tabular_review_chats" && call.op === "select")
        return { data: [{ id: "tc1" }] };
      return {};
    });

    const count = await deleteAllUserTabularReviews(db as never, "u1");

    expect(count).toBe(2);
    const deletes = calls
      .filter((c) => c.op === "delete")
      .map((c) => c.table);
    expect(deletes).toEqual([
      "tabular_review_chat_messages",
      "tabular_review_chats",
      "tabular_cells",
      "tabular_reviews",
    ]);
    expect(
      filterValue(callsFor("tabular_review_chat_messages", "delete")[0], "in", "chat_id"),
    ).toEqual(["tc1"]);
    expect(
      filterValue(callsFor("tabular_reviews", "delete")[0], "in", "id"),
    ).toEqual(["r1", "r2"]);
  });

  it("short-circuits to 0 with no deletes when the user has no reviews", async () => {
    const { db, calls } = makeFakeDb();

    const count = await deleteAllUserTabularReviews(db as never, "u1");

    expect(count).toBe(0);
    expect(calls.filter((c) => c.op === "delete")).toEqual([]);
  });
});

describe("deleteUserProjects", () => {
  it("returns 0 untouched when an explicit project list is empty", async () => {
    const { db, calls } = makeFakeDb();

    expect(await deleteUserProjects(db as never, "u1", [])).toBe(0);
    expect(calls).toEqual([]);
  });

  it("only deletes projects the user owns, and removes version files from storage", async () => {
    const { db, calls } = makeFakeDb((call) => {
      if (call.table === "projects" && call.op === "select")
        return { data: [{ id: "p1" }] };
      if (call.table === "documents" && call.op === "select")
        return { data: [{ id: "d1" }] };
      if (call.table === "document_versions" && call.op === "select")
        return {
          data: [
            { storage_path: "documents/u1/d1/orig.docx", pdf_storage_path: "documents/u1/d1/conv.pdf" },
          ],
        };
      return {};
    });

    const count = await deleteUserProjects(db as never, "u1", ["p1", "p-not-mine"]);

    expect(count).toBe(1);
    // Ownership filter: the project select carries BOTH user_id eq and id in.
    const projectSelect = calls.find(
      (c) => c.table === "projects" && c.op === "select",
    )!;
    expect(filterValue(projectSelect, "eq", "user_id")).toBe("u1");
    expect(filterValue(projectSelect, "in", "id")).toEqual(["p1", "p-not-mine"]);
    // Both storage objects of the version deleted.
    expect(deleteFileMock).toHaveBeenCalledWith("documents/u1/d1/orig.docx");
    expect(deleteFileMock).toHaveBeenCalledWith("documents/u1/d1/conv.pdf");
    // Projects themselves deleted last.
    const deletes = calls.filter((c) => c.op === "delete").map((c) => c.table);
    expect(deletes[deletes.length - 1]).toBe("projects");
  });
});

describe("deleteUserAccountData", () => {
  const baseRespond = (call: DbCall) => {
    if (call.table === "projects" && call.op === "select")
      return { data: [{ id: "p1" }] };
    if (call.table === "documents" && call.op === "select")
      return { data: [{ id: "d1" }] };
    if (call.table === "document_versions" && call.op === "select")
      return {
        data: [
          { storage_path: "documents/u1/d1/a.docx", pdf_storage_path: "documents/u1/d1/a.pdf" },
        ],
      };
    if (call.table === "tabular_reviews" && call.op === "select")
      return { data: [] };
    return {};
  };

  it("deletes storage objects, the user's storage prefix, and every owned table", async () => {
    listFilesMock.mockResolvedValue(["documents/u1/orphan.tmp"]);
    const { db, calls, callsFor } = makeFakeDb(baseRespond);

    await deleteUserAccountData(db as never, "u1", "User@Example.com");

    expect(deleteFileMock).toHaveBeenCalledWith("documents/u1/d1/a.docx");
    expect(deleteFileMock).toHaveBeenCalledWith("documents/u1/d1/a.pdf");
    expect(listFilesMock).toHaveBeenCalledWith("documents/u1/");
    expect(deleteFileMock).toHaveBeenCalledWith("documents/u1/orphan.tmp");

    const deletedTables = calls
      .filter((c) => c.op === "delete")
      .map((c) => c.table);
    for (const table of [
      "documents",
      "tabular_review_chats",
      "tabular_reviews",
      "chats",
      "project_subfolders",
      "hidden_workflows",
      "workflows",
      "projects",
    ]) {
      expect(deletedTables).toContain(table);
    }
    // Upstream a5fe6d6 also deleted from workflow_open_source_submissions,
    // but that feature's schema/route/frontend unit is deliberately deferred.
    expect(callsFor("workflow_open_source_submissions")).toEqual([]);
    // workflow_shares wiped both as sharer and (lowercased) recipient.
    const shareDeletes = callsFor("workflow_shares", "delete");
    expect(shareDeletes).toHaveLength(2);
    expect(filterValue(shareDeletes[0], "eq", "shared_by_user_id")).toBe("u1");
    expect(filterValue(shareDeletes[1], "eq", "shared_with_email")).toBe(
      "user@example.com",
    );
  });

  it("scrubs the email from shared_with arrays on projects and tabular_reviews", async () => {
    const { db, callsFor } = makeFakeDb((call) => {
      if (call.filters.some(([m]) => m.startsWith("filter")))
        return {
          data: [
            { id: "shared-1", shared_with: ["user@example.com", "other@x.com"] },
          ],
        };
      return baseRespond(call);
    });

    await deleteUserAccountData(db as never, "u1", "User@Example.com");

    for (const table of ["projects", "tabular_reviews"] as const) {
      const updates = callsFor(table, "update");
      expect(updates).toHaveLength(1);
      expect(updates[0].payload).toEqual({ shared_with: ["other@x.com"] });
      expect(filterValue(updates[0], "eq", "id")).toBe("shared-1");
    }
  });

  it("skips all email-based cleanup when the principal has no email", async () => {
    const { db, calls, callsFor } = makeFakeDb(baseRespond);

    await deleteUserAccountData(db as never, "u1", null);

    expect(callsFor("workflow_shares", "delete")).toHaveLength(1); // sharer only
    expect(
      calls.filter((c) => c.filters.some(([m]) => m.startsWith("filter"))),
    ).toEqual([]); // no shared_with scans
  });

  it("batches id-based deletes at 500 per statement", async () => {
    const manyDocs = Array.from({ length: 501 }, (_, i) => ({ id: `d${i}` }));
    const { db, callsFor } = makeFakeDb((call) => {
      if (call.table === "documents" && call.op === "select")
        return { data: manyDocs };
      if (call.table === "projects" && call.op === "select")
        return { data: [] };
      return {};
    });

    await deleteUserAccountData(db as never, "u1", null);

    const docDeletes = callsFor("documents", "delete");
    expect(docDeletes).toHaveLength(2);
    expect((filterValue(docDeletes[0], "in", "id") as string[]).length).toBe(500);
    expect((filterValue(docDeletes[1], "in", "id") as string[]).length).toBe(1);
  });

  it("propagates a storage-path load failure with context", async () => {
    const { db } = makeFakeDb((call) => {
      if (call.table === "document_versions")
        return { error: { message: "db down" } };
      return baseRespond(call);
    });

    await expect(
      deleteUserAccountData(db as never, "u1", null),
    ).rejects.toThrow("Failed to load document storage paths: db down");
  });

  it("prefix cleanup is best-effort: listFiles failure does not abort the deletion", async () => {
    listFilesMock.mockRejectedValue(new Error("container listing denied"));
    const { db, callsFor } = makeFakeDb(baseRespond);

    await deleteUserAccountData(db as never, "u1", null);

    expect(callsFor("projects", "delete")).toHaveLength(1);
  });
});
