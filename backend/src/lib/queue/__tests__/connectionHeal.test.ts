import { describe, it, expect, vi, afterAll } from "vitest";

// A flapping Redis link (a restart, a Docker/NAT proxy in the middle) can land
// ioredis events in the order close → stale 'ready', leaving the producer
// connection with status "ready" on a DESTROYED stream. The scheduled
// reconnect then aborts (ioredis refuses to connect a "ready" client), no
// event ever fires again, and every command rejects with "Stream isn't
// writeable" until the process restarts — measured live at 6+ minutes against
// a healthy Redis, with every delivery silently riding the 60s poll backstop.
// disconnect() and even stream.destroy() were tried live and heal nothing:
// the socket is already gone. The only cure is to REPLACE the object, which
// getRedisProducerConnection now does on a synchronous wedge check — and the
// BullMQ Queue singletons must follow by rebuilding on the fresh connection.
vi.hoisted(() => {
    process.env.REDIS_URL = "redis://127.0.0.1:6399";
    process.env.QUEUE_DRIVER = "redis";
    process.env.REDIS_PRODUCER_TIMEOUT_MS = "300";
});

import type IORedis from "ioredis";
import {
    closeRedisConnection,
    getRedisProducerConnection,
} from "../connection";
import { getAppJobsQueue, closeAppJobsQueue } from "../appJobsQueue";

/** Force the exact live-captured wedge shape onto a client. */
function wedge(conn: IORedis): void {
    Object.defineProperty(conn, "status", {
        value: "ready",
        writable: true,
        configurable: true,
    });
    Object.defineProperty(conn, "stream", {
        value: { writable: false, destroyed: true },
        writable: true,
        configurable: true,
    });
}

afterAll(async () => {
    vi.restoreAllMocks();
    await closeAppJobsQueue().catch(() => {});
    await closeRedisConnection().catch(() => {});
});

describe("wedged producer connection replacement", () => {
    it("replaces a connection whose status claims ready on a dead stream", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const first = getRedisProducerConnection();
        // Healthy-shaped (not wedged): repeated calls reuse the instance.
        expect(getRedisProducerConnection()).toBe(first);

        wedge(first);
        const disconnect = vi
            .spyOn(first, "disconnect")
            .mockImplementation(() => {});
        const second = getRedisProducerConnection();
        expect(second).not.toBe(first);
        // The husk is torn down best-effort, never reused.
        expect(disconnect).toHaveBeenCalled();
        // The replacement is stable until IT wedges.
        expect(getRedisProducerConnection()).toBe(second);
    });

    it("leaves a non-ready connection alone — its reconnect loop owns recovery", () => {
        const conn = getRedisProducerConnection();
        Object.defineProperty(conn, "status", {
            value: "reconnecting",
            writable: true,
            configurable: true,
        });
        Object.defineProperty(conn, "stream", {
            value: { writable: false, destroyed: true },
            writable: true,
            configurable: true,
        });
        expect(getRedisProducerConnection()).toBe(conn);
    });

    it("rebuilds the app-jobs Queue when the connection is replaced", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const conn = getRedisProducerConnection();
        const queueBefore = getAppJobsQueue();
        // Same connection: the Queue singleton is reused.
        expect(getAppJobsQueue()).toBe(queueBefore);

        wedge(conn);
        vi.spyOn(conn, "disconnect").mockImplementation(() => {});
        const queueAfter = getAppJobsQueue();
        // A Queue holding the dead client can never deliver again.
        expect(queueAfter).not.toBe(queueBefore);
        expect(getAppJobsQueue()).toBe(queueAfter);
    });
});
