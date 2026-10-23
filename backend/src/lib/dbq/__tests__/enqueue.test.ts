import { describe, it, expect, vi, beforeEach } from "vitest";

// Typed with the real deleteFile's signature so the recorded calls are a
// proper argument tuple rather than an untyped rest array.
const deleteFile = vi.fn<(key: string) => Promise<void>>(async () => {});
vi.mock("../../storage", () => ({
    deleteFile: (key: string) => deleteFile(key),
}));
const reportError = vi.hoisted(() => vi.fn());
vi.mock("../../observability/sentry", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("../../observability/sentry")>();
    reportError.mockImplementation(actual.reportError);
    return { ...actual, reportError };
});

import { diagnosticErrorTags } from "../../observability/sentryPrivacy";
import { enqueueDbJob, enqueueStorageCleanup } from "../enqueue";

// db double: insert(...).select(...).single() resolves `insertResult`;
// the dedupe lookup select(...).eq/in/limit/maybeSingle resolves `existing`.
function makeDb(opts: {
    insertResult: { data: unknown; error: { code?: string; message: string } | null };
    existing?: { id: string } | null;
}) {
    const inserts: Record<string, unknown>[] = [];
    function from() {
        const b: Record<string, unknown> = {
            insert(payload: Record<string, unknown>) {
                inserts.push(payload);
                return b;
            },
            select() {
                return b;
            },
            eq() {
                return b;
            },
            in() {
                return b;
            },
            limit() {
                return b;
            },
            single() {
                return Promise.resolve(opts.insertResult);
            },
            maybeSingle() {
                return Promise.resolve({
                    data: opts.existing ?? null,
                    error: null,
                });
            },
        };
        return b;
    }
    return { inserts, from };
}

beforeEach(() => {
    deleteFile.mockClear();
    reportError.mockClear();
});

describe("enqueueDbJob", () => {
    it("inserts the job and returns its id", async () => {
        const db = makeDb({
            insertResult: { data: { id: "j1" }, error: null },
        });
        const out = await enqueueDbJob(db as never, {
            kind: "export.build",
            payload: { userId: "u" },
            dedupeKey: "export:u:account",
            maxAttempts: 3,
        });
        expect(out).toEqual({ id: "j1", deduped: false });
        expect(db.inserts[0]).toMatchObject({
            kind: "export.build",
            dedupe_key: "export:u:account",
            max_attempts: 3,
        });
    });

    it("treats a unique violation on the dedupe key as success (already queued)", async () => {
        const db = makeDb({
            insertResult: {
                data: null,
                error: { code: "23505", message: "duplicate key value" },
            },
            existing: { id: "live-1" },
        });
        const out = await enqueueDbJob(db as never, {
            kind: "export.build",
            payload: {},
            dedupeKey: "export:u:account",
        });
        expect(out).toEqual({ id: "live-1", deduped: true });
    });

    // The thrown error names the kind and keeps PostgREST's answer as the
    // cause, so the caller that reports it gets the SQLSTATE as failure_code
    // instead of a bare "[dbq] enqueue ... failed" string.
    it("throws a dbq.enqueue_failed error carrying the PostgREST cause", async () => {
        const pgError = { code: "42P01", message: "relation db_jobs does not exist" };
        const db = makeDb({ insertResult: { data: null, error: pgError } });
        const thrown = await enqueueDbJob(db as never, {
            kind: "export.build",
            payload: {},
        }).catch((error: unknown) => error);
        expect(thrown).toMatchObject({
            message: expect.stringContaining("enqueue export.build failed"),
            cause: pgError,
        });
        expect(diagnosticErrorTags(thrown)).toEqual({
            error_kind: "dbq.enqueue_failed",
            failure_code: "42P01",
        });
    });

    it("throws on real insert failures so callers can fall back", async () => {
        const db = makeDb({
            insertResult: {
                data: null,
                error: { code: "XX000", message: "connection refused" },
            },
        });
        await expect(
            enqueueDbJob(db as never, { kind: "x", payload: {} }),
        ).rejects.toThrow(/connection refused/);
    });
});

describe("enqueueStorageCleanup", () => {
    it("is a no-op with nothing to clean", async () => {
        const db = makeDb({ insertResult: { data: { id: "j" }, error: null } });
        await enqueueStorageCleanup(db as never, []);
        expect(db.inserts).toHaveLength(0);
    });

    it("surfaces enqueue failure so cleanup cannot be reported successful", async () => {
        const db = makeDb({
            insertResult: {
                data: null,
                error: { code: "XX000", message: "db down" },
            },
        });
        await expect(enqueueStorageCleanup(db as never, ["a.pdf", "b.pdf"]))
            .rejects.toThrow(/db down/);
        expect(deleteFile).not.toHaveBeenCalled();
    });

    it("does not attempt an unsafe inline fallback", async () => {
        const db = makeDb({
            insertResult: {
                data: null,
                error: { code: "XX000", message: "db down" },
            },
        });
        await expect(
            enqueueStorageCleanup(db as never, ["a.pdf"]),
        ).rejects.toThrow(/db down/);
        expect(deleteFile).not.toHaveBeenCalled();
    });
});
