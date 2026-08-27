import IORedis from "ioredis";

/** REDIS_URL points at the Redis instance backing BullMQ; defaults to
 *  localhost for bare-metal dev. Only ever dialled when the Redis driver is
 *  selected — the default (Postgres-queue) deployment needs no Redis. */
export const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

/**
 * There are TWO Redis connections, because producers and workers want opposite
 * failure behaviour and they cannot share one client's options.
 *
 * WORKERS (`getRedisConnection`) must never have a command deadline: BullMQ's
 * consumer loop parks on blocking commands (BZPOPMIN/BRPOPLPUSH) for seconds at
 * a time, which is exactly why `maxRetriesPerRequest: null` is mandatory there.
 * A `commandTimeout` on this connection would abort the blocking read and the
 * worker would spin.
 *
 * PRODUCERS (`getRedisProducerConnection`) want the opposite. Delivery to Redis
 * is best-effort in this codebase — the db_jobs row is the durable record and
 * the poller is the backstop — so a producer command against a Redis that is
 * down must FAIL, fast, rather than sit in ioredis's offline queue waiting for
 * a reconnect that may be hours away. With the worker options, an enqueue on a
 * request thread (chat audit, account deletion, export scheduling) buffers
 * forever and the HTTP request never responds: the "best-effort" try/catch
 * around it never runs, because the promise never settles.
 */
let connection: IORedis | null = null;
let producerConnection: IORedis | null = null;

/** Producer command budget. Small: this is a local network hop. */
export function redisProducerTimeoutMs(): number {
    const raw = Number(process.env.REDIS_PRODUCER_TIMEOUT_MS);
    return Number.isFinite(raw) && raw >= 50 ? raw : 5_000;
}

/**
 * Shared Redis connection for BullMQ WORKERS. Lazily created and reused.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ: its blocking commands
 * (BRPOPLPUSH etc.) must not be aborted by ioredis's per-request retry cap.
 */
export function getRedisConnection(): IORedis {
    if (!connection) {
        connection = new IORedis(REDIS_URL, {
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
        });
    }
    return connection;
}

/**
 * Shared Redis connection for PRODUCERS (Queue instances, pub/sub publishes).
 * `enableOfflineQueue: false` makes commands issued while disconnected reject
 * immediately instead of buffering without bound, and `commandTimeout` bounds
 * one that was accepted just before the link died.
 */
export function getRedisProducerConnection(): IORedis {
    if (!producerConnection) {
        producerConnection = new IORedis(REDIS_URL, {
            maxRetriesPerRequest: 1,
            enableReadyCheck: false,
            enableOfflineQueue: false,
            commandTimeout: redisProducerTimeoutMs(),
        });
        // ioredis emits 'error' on every failed reconnect attempt. Without a
        // listener that is an unhandled 'error' event, which crashes the
        // process — the precise opposite of best-effort.
        producerConnection.on("error", () => {});
    }
    return producerConnection;
}

/**
 * Hard deadline around one producer-side Redis interaction.
 *
 * The connection options above are necessary but NOT sufficient: BullMQ's
 * `Queue#add` first awaits its own `waitUntilReady()`, which resolves only
 * when the client connects and is not bounded by any ioredis option. Against a
 * dead Redis that await never settles (measured: still pending after 8s with
 * both option sets), so the only thing that actually guarantees the caller
 * gets control back is a race at the call boundary.
 *
 * Callers treat a rejection as "delivery didn't happen" — which for every
 * producer in this codebase means the Postgres record still exists and the
 * poll backstop will run the work.
 */
export async function withRedisTimeout<T>(
    label: string,
    run: () => Promise<T>,
): Promise<T> {
    const budget = redisProducerTimeoutMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            run(),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new Error(
                                `[redis] ${label} timed out after ${budget}ms`,
                            ),
                        ),
                    budget,
                );
                timer.unref?.();
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export async function closeRedisConnection(): Promise<void> {
    const closing: Promise<unknown>[] = [];
    if (connection) {
        closing.push(connection.quit().catch(() => connection?.disconnect()));
        connection = null;
    }
    if (producerConnection) {
        const p = producerConnection;
        closing.push(p.quit().catch(() => p.disconnect()));
        producerConnection = null;
    }
    await Promise.all(closing);
}
