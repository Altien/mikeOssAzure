import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeDb, type DbCall } from "../test/helpers/fakeDb";

const { deleteFileMock, listFilesMock } = vi.hoisted(() => ({
  deleteFileMock: vi.fn(),
  listFilesMock: vi.fn(),
}));

// Dev drift: upstream #295 moved lib/userDataCleanup to modules/user/user.dataCleanup,
// which also needs assertStorageConfigured/extractedTextKey from storage.
vi.mock("./storage", () => ({
  assertStorageConfigured: vi.fn(),
  deleteFile: deleteFileMock,
  listFiles: listFilesMock,
  extractedTextKey: (versionId: string) => `extracted-text/${versionId}.txt`,
}));

import {
  deleteAllUserChats,
  deleteAllUserTabularReviews,
  deleteUserProjects,
} from "../modules/user/user.dataCleanup";

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
  // Dev drift: upstream #295 deletes only the parent reviews and relies on the
  // schema's ON DELETE CASCADE for chats/messages/cells (0000_initial.sql).
  it("deletes only the parent reviews (children cascade) and returns the review count", async () => {
    const { db, calls, callsFor } = makeFakeDb((call) => {
      if (call.table === "tabular_reviews" && call.op === "select")
        return { data: [{ id: "r1" }, { id: "r2" }] };
      return {};
    });

    const count = await deleteAllUserTabularReviews(db as never, "u1");

    expect(count).toBe(2);
    const deletes = calls
      .filter((c) => c.op === "delete")
      .map((c) => c.table);
    expect(deletes).toEqual(["tabular_reviews"]);
    expect(
      filterValue(callsFor("tabular_reviews", "delete")[0], "in", "id"),
    ).toEqual(["r1", "r2"]);
  });

  it("batches id-based deletes at 500 per statement", async () => {
    const manyReviews = Array.from({ length: 501 }, (_, i) => ({ id: `r${i}` }));
    const { db, callsFor } = makeFakeDb((call) =>
      call.table === "tabular_reviews" && call.op === "select"
        ? { data: manyReviews }
        : {},
    );

    expect(await deleteAllUserTabularReviews(db as never, "u1")).toBe(501);

    const reviewDeletes = callsFor("tabular_reviews", "delete");
    expect(reviewDeletes).toHaveLength(2);
    expect((filterValue(reviewDeletes[0], "in", "id") as string[]).length).toBe(500);
    expect((filterValue(reviewDeletes[1], "in", "id") as string[]).length).toBe(1);
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

  // Dev drift: upstream #295 moved storage cleanup to the documents module's
  // inline/durable cleanup; storage-key assertions now live in
  // modules/user/__tests__/user.dataCleanup.test.ts ("cascades project contents and
  // storage files for owned projects"). This keeps the ownership filter check.
  it("only deletes projects the user owns", async () => {
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
      if (call.table === "db_jobs" && call.op === "insert")
        return { data: { id: "storage-job-1" } };
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
    // Projects themselves deleted last.
    const deletes = calls.filter((c) => c.op === "delete").map((c) => c.table);
    expect(deletes[deletes.length - 1]).toBe("projects");
  });
});

// Dev drift: the deleteUserAccountData cases that lived here asserted the
// pre-#295 shape (explicit child enumeration, call-order deletes) and need
// `.not(...)` chains this call-recording fake does not model. Their coverage
// (storage objects + prefixes, owned tables, OSS submissions, workflow shares,
// shared_with scrubbing, no-email path, prefix-failure retry, and Dev's
// user_router_models erasure) lives in the stateful-fake suites
// modules/user/__tests__/user.dataCleanup.test.ts and
// user.dataCleanup.orgs.test.ts.
