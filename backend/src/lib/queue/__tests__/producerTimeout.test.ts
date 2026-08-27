import { describe, it, expect, vi } from "vitest";

// Redis delivery is best-effort everywhere in this codebase: the db_jobs row is
// the durable record and the poller is the backstop. That contract only holds
// if a producer command against a DEAD Redis actually fails — with the worker
// connection options (maxRetriesPerRequest: null, offline queue on) it instead
// buffers, BullMQ's own waitUntilReady never resolves, and the enqueue promise
// never settles. The caller's try/catch cannot fire on a promise that never
// settles, so the HTTP request that was "best-effort enqueuing" simply hangs.
//
// These tests dial a port with nothing on it. Without a deadline they hang
// until vitest's own timeout; with one they reject promptly.
vi.hoisted(() => {
    process.env.REDIS_URL = "redis://127.0.0.1:6399";
    process.env.QUEUE_DRIVER = "redis";
    process.env.REDIS_PRODUCER_TIMEOUT_MS = "300";
});

import { closeRedisConnection } from "../connection";
import { enqueueAppJobDelivery, closeAppJobsQueue } from "../appJobsQueue";
import { enqueueDbJob } from "../../dbq/enqueue";

const DEAD_REDIS_BUDGET_MS = 3_000;

describe("producer-side Redis delivery is deadline-bounded", () => {
    it("rejects instead of hanging when Redis is unreachable", async () => {
        const started = Date.now();
        await expect(enqueueAppJobDelivery("job-1")).rejects.toThrow(/timed out|ECONNREFUSED|Stream isn't writeable|Connection is closed/);
        expect(Date.now() - started).toBeLessThan(DEAD_REDIS_BUDGET_MS);
        await closeAppJobsQueue().catch(() => {});
        await closeRedisConnection().catch(() => {});
    }, 10_000);

    it("enqueueDbJob still resolves — the durable row is what matters", async () => {
        // Minimal chainable Supabase double: the insert succeeds, so the only
        // thing that can stall enqueueDbJob is the Redis delivery below it.
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "in", "limit"]) q[m] = () => q;
        q.insert = () => q;
        q.single = async () => ({ data: { id: "row-1" }, error: null });
        q.maybeSingle = async () => ({ data: null, error: null });
        const db = { from: () => q } as never;

        const errors: unknown[] = [];
        const spy = vi
            .spyOn(console, "error")
            .mockImplementation((...args) => void errors.push(args));

        const started = Date.now();
        const out = await enqueueDbJob(db, { kind: "audit.chat_turn", payload: {} });
        expect(out).toEqual({ id: "row-1", deduped: false });
        expect(Date.now() - started).toBeLessThan(DEAD_REDIS_BUDGET_MS);
        // The failure was reported, not swallowed silently.
        expect(errors.length).toBeGreaterThan(0);
        spy.mockRestore();
        await closeAppJobsQueue().catch(() => {});
        await closeRedisConnection().catch(() => {});
    }, 10_000);
});
