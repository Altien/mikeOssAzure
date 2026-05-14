import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkProjectAccess,
  ensureDocAccess,
  ensureReviewAccess,
  filterAccessibleDocumentIds,
  listAccessibleProjectIds,
} from "./access";

type QueryResult = {
  data?: unknown;
  error?: { message: string; code?: string; details?: string } | null;
};

function makeQuery(result: QueryResult) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = chain;
  builder.eq = chain;
  builder.in = chain;
  builder.contains = chain;
  builder.neq = chain;
  builder.single = chain;
  builder.then = (
    onFulfilled: (value: QueryResult) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(onFulfilled, onRejected);
  return builder;
}

/**
 * Per-table queue of results: each `db.from(table)` call shifts the next
 * result off the queue, so a function that hits the same table twice (e.g.
 * `listAccessibleProjectIds`) can return different data for each call.
 */
function makeFakeDb(perTable: Record<string, QueryResult[]>) {
  const queues: Record<string, QueryResult[]> = {};
  for (const [k, v] of Object.entries(perTable)) queues[k] = [...v];
  const from = vi.fn((table: string) => {
    const q = queues[table];
    if (!q || q.length === 0) {
      throw new Error(`fake db: no queued result for table "${table}"`);
    }
    return makeQuery(q.shift()!);
  });
  return { from } as unknown as Parameters<typeof checkProjectAccess>[3];
}

describe("checkProjectAccess", () => {
  it("returns ok:false when the project does not exist", async () => {
    const db = makeFakeDb({ projects: [{ data: null }] });

    const result = await checkProjectAccess("p1", "u1", "u@example.com", db);

    expect(result).toEqual({ ok: false });
  });

  it("returns isOwner:true when the caller owns the project", async () => {
    const project = { id: "p1", user_id: "u1", shared_with: null };
    const db = makeFakeDb({ projects: [{ data: project }] });

    const result = await checkProjectAccess("p1", "u1", "u@example.com", db);

    expect(result).toEqual({ ok: true, isOwner: true, project });
  });

  it("returns isOwner:false when the caller's email is in shared_with", async () => {
    const project = {
      id: "p1",
      user_id: "owner",
      shared_with: ["other@example.com", "Caller@Example.com"],
    };
    const db = makeFakeDb({ projects: [{ data: project }] });

    const result = await checkProjectAccess(
      "p1",
      "u1",
      "caller@example.com",
      db,
    );

    expect(result).toEqual({ ok: true, isOwner: false, project });
  });

  it("returns ok:false when the caller is neither owner nor shared", async () => {
    const project = {
      id: "p1",
      user_id: "owner",
      shared_with: ["someone-else@example.com"],
    };
    const db = makeFakeDb({ projects: [{ data: project }] });

    const result = await checkProjectAccess(
      "p1",
      "u1",
      "caller@example.com",
      db,
    );

    expect(result).toEqual({ ok: false });
  });

  it("treats shared_with:null as an empty list rather than crashing", async () => {
    const project = { id: "p1", user_id: "owner", shared_with: null };
    const db = makeFakeDb({ projects: [{ data: project }] });

    const result = await checkProjectAccess(
      "p1",
      "u1",
      "caller@example.com",
      db,
    );

    expect(result).toEqual({ ok: false });
  });

  it("returns ok:false when the caller has no email and is not the owner", async () => {
    const project = {
      id: "p1",
      user_id: "owner",
      shared_with: ["", "another@example.com"],
    };
    const db = makeFakeDb({ projects: [{ data: project }] });

    const result = await checkProjectAccess("p1", "u1", null, db);

    expect(result).toEqual({ ok: false });
  });
});

describe("ensureDocAccess", () => {
  it("short-circuits when the caller owns the doc", async () => {
    const db = makeFakeDb({});

    const result = await ensureDocAccess(
      { user_id: "u1", project_id: "p1" },
      "u1",
      "u@example.com",
      db,
    );

    expect(result).toEqual({ ok: true, isOwner: true });
  });

  it("denies when the doc has no project_id and the caller is not the owner", async () => {
    const db = makeFakeDb({});

    const result = await ensureDocAccess(
      { user_id: "owner", project_id: null },
      "u1",
      "u@example.com",
      db,
    );

    expect(result).toEqual({ ok: false });
  });

  it("allows when the caller has shared access to the doc's project", async () => {
    const project = {
      id: "p1",
      user_id: "owner",
      shared_with: ["caller@example.com"],
    };
    const db = makeFakeDb({ projects: [{ data: project }] });

    const result = await ensureDocAccess(
      { user_id: "owner", project_id: "p1" },
      "u1",
      "caller@example.com",
      db,
    );

    expect(result).toEqual({ ok: true, isOwner: false });
  });

  it("denies when the doc's project is not accessible", async () => {
    const project = { id: "p1", user_id: "owner", shared_with: [] };
    const db = makeFakeDb({ projects: [{ data: project }] });

    const result = await ensureDocAccess(
      { user_id: "owner", project_id: "p1" },
      "u1",
      "caller@example.com",
      db,
    );

    expect(result).toEqual({ ok: false });
  });
});

describe("ensureReviewAccess", () => {
  it("short-circuits when the caller owns the review", async () => {
    const db = makeFakeDb({});

    const result = await ensureReviewAccess(
      { user_id: "u1", project_id: null, shared_with: null },
      "u1",
      "u@example.com",
      db,
    );

    expect(result).toEqual({ ok: true, isOwner: true });
  });

  it("grants access when the review is directly shared with the caller's email", async () => {
    const db = makeFakeDb({});

    const result = await ensureReviewAccess(
      {
        user_id: "owner",
        project_id: null,
        shared_with: ["Caller@Example.com"],
      },
      "u1",
      "caller@example.com",
      db,
    );

    expect(result).toEqual({ ok: true, isOwner: false });
  });

  it("falls through to project membership when project_id is set", async () => {
    const project = {
      id: "p1",
      user_id: "owner",
      shared_with: ["caller@example.com"],
    };
    const db = makeFakeDb({ projects: [{ data: project }] });

    const result = await ensureReviewAccess(
      { user_id: "owner", project_id: "p1", shared_with: null },
      "u1",
      "caller@example.com",
      db,
    );

    expect(result).toEqual({ ok: true, isOwner: false });
  });

  it("denies a standalone review the caller has no relationship to", async () => {
    const db = makeFakeDb({});

    const result = await ensureReviewAccess(
      { user_id: "owner", project_id: null, shared_with: [] },
      "u1",
      "caller@example.com",
      db,
    );

    expect(result).toEqual({ ok: false });
  });
});

describe("filterAccessibleDocumentIds", () => {
  it("short-circuits on an empty input without touching the db", async () => {
    const db = makeFakeDb({});

    const result = await filterAccessibleDocumentIds(
      [],
      "u1",
      "u@example.com",
      db,
    );

    expect(result).toEqual([]);
    expect((db as unknown as { from: ReturnType<typeof vi.fn> }).from)
      .not.toHaveBeenCalled();
  });

  it("returns ids the caller owns plus ids whose project is accessible, and drops the rest", async () => {
    const docs = [
      { id: "d-own", user_id: "u1", project_id: null },
      { id: "d-shared-project", user_id: "owner", project_id: "p-shared" },
      { id: "d-foreign", user_id: "owner", project_id: "p-foreign" },
      { id: "d-orphan", user_id: "owner", project_id: null },
    ];
    const db = makeFakeDb({
      documents: [{ data: docs }],
      projects: [
        { data: [] },
        { data: [{ id: "p-shared" }] },
      ],
    });

    const result = await filterAccessibleDocumentIds(
      ["d-own", "d-shared-project", "d-foreign", "d-orphan"],
      "u1",
      "caller@example.com",
      db,
    );

    expect(result.sort()).toEqual(["d-own", "d-shared-project"].sort());
  });

  it("returns an empty array when none of the ids match in the db", async () => {
    const db = makeFakeDb({
      documents: [{ data: [] }],
    });

    const result = await filterAccessibleDocumentIds(
      ["d-missing"],
      "u1",
      "caller@example.com",
      db,
    );

    expect(result).toEqual([]);
  });
});

describe("listAccessibleProjectIds", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns owned project ids and skips the shared query when email is null", async () => {
    const db = makeFakeDb({
      projects: [{ data: [{ id: "p1" }, { id: "p2" }] }],
    });

    const result = await listAccessibleProjectIds("u1", null, db);

    expect(result.sort()).toEqual(["p1", "p2"]);
  });

  it("merges owned and shared project ids when email is provided", async () => {
    const db = makeFakeDb({
      projects: [
        { data: [{ id: "owned-1" }] },
        { data: [{ id: "shared-1" }, { id: "shared-2" }] },
      ],
    });

    const result = await listAccessibleProjectIds(
      "u1",
      "caller@example.com",
      db,
    );

    expect(result.sort()).toEqual(["owned-1", "shared-1", "shared-2"]);
  });

  it("deduplicates ids that appear in both owned and shared results", async () => {
    const db = makeFakeDb({
      projects: [
        { data: [{ id: "p1" }] },
        { data: [{ id: "p1" }, { id: "p2" }] },
      ],
    });

    const result = await listAccessibleProjectIds(
      "u1",
      "caller@example.com",
      db,
    );

    expect(result.sort()).toEqual(["p1", "p2"]);
  });

  it("logs and swallows shared-query errors, still returning owned ids", async () => {
    const db = makeFakeDb({
      projects: [
        { data: [{ id: "owned-only" }] },
        { data: null, error: { message: "boom", code: "42P01" } },
      ],
    });

    const result = await listAccessibleProjectIds(
      "u1",
      "caller@example.com",
      db,
    );

    expect(result).toEqual(["owned-only"]);
    expect(console.error).toHaveBeenCalledWith(
      "[access] shared_with query failed",
      expect.objectContaining({ message: "boom", code: "42P01" }),
    );
  });

  it("throws when the owned-projects query errors", async () => {
    const db = makeFakeDb({
      projects: [
        { data: null, error: { message: "db down", code: "57P03" } },
      ],
    });

    await expect(
      listAccessibleProjectIds("u1", null, db),
    ).rejects.toThrow(/listAccessibleProjectIds: db down/);
  });
});
