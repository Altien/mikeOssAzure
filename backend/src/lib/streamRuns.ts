import type { Response } from "express";
import { once } from "node:events";
import { streamRunCluster, type RunRow } from "./streamRunCluster";

/**
 * Server-owned streaming runs.
 *
 * A *run* is a unit of generation the server owns rather than the HTTP
 * response that asked for it. Before this module existed, generation lived
 * inside its request: the SSE socket closing (a refresh, a closed tab, a
 * dropped connection) aborted the work. Now the route registers a run, writes
 * frames into the run's buffer instead of the socket, and any number of
 * responses attach to it: the original request, a reload, a second tab. A
 * response attaching late gets the buffered frames replayed from the sequence
 * number it last saw, then tails the live ones. Closing a response detaches it
 * and nothing else; only `stop()` (an explicit Stop endpoint) aborts the work.
 *
 * Frames keep their wire form (`data: <json>\n\n`) and gain an SSE `id:` line
 * carrying the sequence number, which is what a client sends back as `from`
 * when it reconnects.
 *
 * A run is identified two ways: by `id` (what a client resumes) and by `key`
 * (what may only have one run at a time — `chat:<chatId>` for an assistant
 * turn, `review:<reviewId>` for a tabular generation). The surface that owns
 * the run keeps its own state in the opaque `meta` object.
 *
 * The owner keeps frames in volatile memory. PostgreSQL fences ownership and
 * carries metadata; another replica requests replay pages over an encrypted
 * transient relay. A dead owner is reported as owner_lost, never restarted.
 * A finished run is retained briefly for reconnects.
 */

export const FINISHED_RUN_RETENTION_MS = 60_000;
/** A safety net, not a feature: the work is bounded, but a hung provider is not. */
export const MAX_RUN_LIFETIME_MS = 30 * 60_000;
const MAX_BUFFERED_RUN_BYTES = 16 * 1024 * 1024;
const MAX_SSE_READER_QUEUE_BYTES = 1024 * 1024;
/**
 * How long a STOPPED run may take to finish on its own before the registry
 * finishes it. `stop()` only aborts the signal; the route is expected to unwind,
 * persist its partial and call `finish()`. A route that never does (a provider
 * or tool call that ignores the abort, a throw before the route's try/finally)
 * would otherwise hold the key forever, and every later send into that chat or
 * review would answer 409 until the process restarted.
 */
export const STOPPED_RUN_GRACE_MS = 30_000;

/**
 * Whether a buffered frame is still worth replaying to a client that attaches
 * later. Always true unless the writer said otherwise.
 */
type ReplayPredicate = () => boolean;

type Frame = { seq: number; line: string; replay: ReplayPredicate };

export type StreamRunSubscriber = {
    write: (chunk: string) => void | Promise<void>;
    end: () => void;
};

export type StreamRunWriteOptions = {
    /**
     * Replay this frame to a late subscriber only while the predicate holds.
     * The frame still fans out LIVE to everyone attached when it is written —
     * this only governs the replay a later `subscribe` performs. Transient
     * state (a spinner, a "generating" cell that has since gone terminal) is
     * worth announcing as it happens and misleading to replay afterwards.
     */
    replay?: ReplayPredicate;
};

export type StreamRun<Meta = Record<string, unknown>> = {
    readonly id: string;
    /** What may only have one run at a time, e.g. `chat:<id>`, `review:<id>`. */
    readonly key: string;
    readonly userId: string;
    /** Surface-owned state. Opaque here. */
    readonly meta: Meta;
    readonly startedAt: number;
    /** Aborted by `stop()` only. Hand this to the model call. */
    readonly signal: AbortSignal;
    readonly seq: number;
    readonly finished: boolean;
    readonly stopped: boolean;
    /**
     * Append one SSE record (`data: ...\n\n`) and fan it out. A COMMENT line
     * (one starting with `:`) is fanned out live but neither buffered nor
     * numbered — it is a keep-alive, not content.
     */
    write: (line: string, opts?: StreamRunWriteOptions) => boolean;
    /** The work is over: end every attached response and start the retention clock. */
    finish: () => void;
    /** Explicit cancel: abort the work. The route decides what to persist. */
    stop: () => void;
    /**
     * Replay frames with `seq >= from` (skipping any whose replay predicate no
     * longer holds), then tail. The subscriber is ended when the run finishes.
     * Returns the detach function.
     */
    subscribe: (from: number, subscriber: StreamRunSubscriber) => () => void;
};

type RunRecord<Meta> = StreamRun<Meta> & {
    frames: Frame[];
    subscribers: Set<StreamRunSubscriber>;
    controller: AbortController;
    retention: ReturnType<typeof setTimeout> | null;
    lifetime: ReturnType<typeof setTimeout> | null;
    grace: ReturnType<typeof setTimeout> | null;
    clusterRow?: RunRow;
    heartbeat?: ReturnType<typeof setInterval> | null;
    bufferedBytes: number;
    bufferExhausted: boolean;
};

/** The registry is meta-agnostic; each caller casts back to its own shape. */
type StoredRun = RunRecord<unknown>;

const runs = new Map<string, StoredRun>();
const runsByKey = new Map<string, StoredRun>();

const alwaysReplay: ReplayPredicate = () => true;

function frameChunk(frame: Frame): string {
    return `id: ${frame.seq}\n${frame.line}`;
}

function remove(run: StoredRun) {
    if (run.retention) clearTimeout(run.retention);
    if (run.lifetime) clearTimeout(run.lifetime);
    if (run.grace) clearTimeout(run.grace);
    if (run.heartbeat) clearInterval(run.heartbeat);
    runs.delete(run.id);
    if (runsByKey.get(run.key) === run) runsByKey.delete(run.key);
}

/**
 * Register a run under `key`. Returns null when a run is still generating
 * under that key: two concurrent writers on one chat thread interleave their
 * rows, and two concurrent generations on one review fight over its cells, so
 * the server refuses the one that did not know.
 *
 * A FINISHED run keeps its key entry until the retention window closes (that
 * is how a client reconnecting just after the end still finds the terminal
 * frames), but it never blocks a successor.
 */
export function startStreamRun<Meta = Record<string, unknown>>(args: {
    id: string;
    key: string;
    userId: string;
    meta?: Meta;
    /**
     * Terminal SSE records to emit when a stopped route does not unwind during
     * the grace period. The owning surface supplies its own wire contract; the
     * registry only guarantees that readers see those records before EOF.
     */
    forcedStopFrames: readonly string[];
    clusterRow?: RunRow;
}): StreamRun<Meta> | null {
    const current = runsByKey.get(args.key);
    if (current && !current.finished) return null;
    const controller = new AbortController();
    let seq = 0;
    let finished = false;
    let stopped = false;
    const run: RunRecord<Meta> = {
        id: args.id,
        key: args.key,
        userId: args.userId,
        meta: (args.meta ?? ({} as Meta)) as Meta,
        startedAt: Date.now(),
        signal: controller.signal,
        get seq() {
            return seq;
        },
        get finished() {
            return finished;
        },
        get stopped() {
            return stopped;
        },
        frames: [],
        subscribers: new Set(),
        controller,
        retention: null,
        lifetime: null,
        grace: null,
        clusterRow: args.clusterRow,
        heartbeat: null,
        bufferedBytes: 0,
        bufferExhausted: false,
        write(line: string, opts?: StreamRunWriteOptions) {
            if (finished) return false;
            // SSE COMMENT lines (`: tool-wait`) are not records: they carry
            // no payload, exist only to stop an intermediary idling the
            // connection out, and mean nothing to a client that arrives
            // later. Fan them out live, but never buffer or number them —
            // otherwise a Word turn waiting on a client tool call would
            // replay hundreds of comments to a reattaching pane and push
            // every real frame's sequence number along with them.
            if (line.startsWith(":")) {
                for (const subscriber of [...run.subscribers]) {
                    try {
                        subscriber.write(line);
                    } catch {
                        run.subscribers.delete(subscriber);
                    }
                }
                return true;
            }
            const size = Buffer.byteLength(line);
            if (!run.bufferExhausted && run.bufferedBytes + size > MAX_BUFFERED_RUN_BYTES) {
                run.bufferExhausted = true;
                controller.abort();
                run.write(`data: ${JSON.stringify({ type: "error", code: "stream_buffer_exhausted", detail: "This response exceeded the replay limit." })}\n\n`);
                run.write("data: [DONE]\n\n");
                run.finish();
                return false;
            }
            seq += 1;
            const frame = { seq, line, replay: opts?.replay ?? alwaysReplay };
            run.frames.push(frame);
            run.bufferedBytes += size;
            if (args.clusterRow) {
                // The SQL watermark contains no frame content. Losing the
                // lease aborts this owner; remote subscribers pull the bytes
                // from our volatile buffer through the encrypted relay.
                void streamRunCluster()?.advertise(args.clusterRow, seq).then((valid) => {
                    if (!valid && !finished) ownerLost(run);
                }).catch(() => ownerLost(run));
            }
            const chunk = frameChunk(frame);
            for (const subscriber of [...run.subscribers]) {
                try {
                    subscriber.write(chunk);
                } catch {
                    run.subscribers.delete(subscriber);
                }
            }
            return true;
        },
        finish() {
            if (finished) return;
            finished = true;
            for (const subscriber of [...run.subscribers]) {
                try {
                    subscriber.end();
                } catch {
                    /* the response is gone either way */
                }
            }
            run.subscribers.clear();
            if (run.lifetime) clearTimeout(run.lifetime);
            run.lifetime = null;
            if (run.grace) clearTimeout(run.grace);
            run.grace = null;
            run.retention = setTimeout(() => remove(run), FINISHED_RUN_RETENTION_MS);
            run.retention.unref?.();
            if (run.heartbeat) clearInterval(run.heartbeat);
            if (args.clusterRow) void streamRunCluster()?.finish(args.clusterRow, seq).catch(() => {});
        },
        stop() {
            if (finished || stopped) return;
            stopped = true;
            if (args.clusterRow) void streamRunCluster()?.stop(args.clusterRow.id, args.clusterRow.fence).catch(() => {});
            controller.abort();
            // The route owns the orderly ending; this is the disorderly one.
            // Whatever it is still awaiting, the key is free again after the
            // grace period and attached readers get their terminal frame.
            run.grace = setTimeout(() => {
                for (const frame of args.forcedStopFrames) run.write(frame);
                run.finish();
            }, STOPPED_RUN_GRACE_MS);
            run.grace.unref?.();
        },
        subscribe(from: number, subscriber: StreamRunSubscriber) {
            for (const frame of run.frames) {
                if (frame.seq >= from && frame.replay())
                    subscriber.write(frameChunk(frame));
            }
            if (finished) {
                subscriber.end();
                return () => {};
            }
            run.subscribers.add(subscriber);
            return () => {
                run.subscribers.delete(subscriber);
            };
        },
    };
    run.lifetime = setTimeout(() => run.stop(), MAX_RUN_LIFETIME_MS);
    run.lifetime.unref?.();
    runs.set(run.id, run as StoredRun);
    runsByKey.set(run.key, run as StoredRun);
    if (args.clusterRow) {
        run.heartbeat = setInterval(() => {
            void streamRunCluster()?.renew(args.clusterRow!).then((current) => {
                if (!current) ownerLost(run);
                else if (current.state === "stopping") run.stop();
            }).catch(() => ownerLost(run));
        }, 5_000);
        run.heartbeat.unref?.();
    }
    return run;
}

function ownerLost(run: StoredRun): void {
    if (run.finished) return;
    run.controller.abort();
    run.write(`data: ${JSON.stringify({ type: "error", detail: "The response owner became unavailable.", code: "owner_lost" })}\n\n`);
    run.write("data: [DONE]\n\n");
    run.finish();
}

/** Atomic cross-replica claim; the sync constructor above remains a test seam. */
export async function claimStreamRun<Meta = Record<string, unknown>>(args: {
    id: string; key: string; userId: string; meta?: Meta; forcedStopFrames: readonly string[];
}): Promise<StreamRun<Meta> | null> {
    const cluster = streamRunCluster();
    const local = runsByKey.get(args.key);
    if (local && !local.finished) return null;
    if (cluster && local?.clusterRow && local.finished)
        await cluster.finish(local.clusterRow, local.seq);
    if (!cluster) {
        if (process.env.NODE_ENV !== "test") throw new Error("Stream run cluster was not initialized");
        return startStreamRun(args);
    }
    const row = await cluster.claim({
        id: args.id, key: args.key, userId: args.userId,
        surface: args.key.split(":", 1)[0],
        meta: (args.meta ?? {}) as Record<string, unknown>,
    });
    return row ? startStreamRun({ ...args, clusterRow: row }) : null;
}

type RunPage = { frames: { seq: number; chunk: string }[]; next: number; finished: boolean };
function readPage(run: StoredRun, from: number): RunPage {
    const frames: RunPage["frames"] = [];
    let next = from;
    let bytes = 0;
    for (const frame of run.frames) {
        if (frame.seq < from) continue;
        const chunk = frameChunk(frame);
        if (frames.length >= 32 || (bytes + Buffer.byteLength(chunk) > 32_000 && frames.length)) break;
        next = frame.seq + 1; // advance past intentionally non-replayable frames
        if (!frame.replay()) continue;
        frames.push({ seq: frame.seq, chunk });
        bytes += Buffer.byteLength(chunk);
    }
    return { frames, next, finished: run.finished };
}

/** Called after cluster startup, before listen(), to serve owner-local pages. */
export function installStreamRunRelayHandler(
    onToolResult?: (data: unknown) => Promise<unknown>,
): void {
    const cluster = streamRunCluster();
    if (!cluster) throw new Error("Stream run cluster was not initialized");
    cluster.setHandler(async (op, data) => {
        if (op === "tool_result" && onToolResult) return onToolResult(data);
        if (op !== "page" || !data || typeof data !== "object") throw new Error("Invalid relay request");
        const { id, fence, from } = data as { id: string; fence: string; from: number };
        const row = await cluster.lookup(id);
        if (!row || row.owner_instance !== cluster.instanceId || row.fence !== fence) throw new Error("Stale stream owner");
        const run = runs.get(id);
        if (!run) throw new Error("Stream owner unavailable");
        return readPage(run, Math.max(1, Math.floor(from)));
    });
}

function remoteRun<Meta>(row: RunRow): StreamRun<Meta> {
    const cluster = streamRunCluster()!;
    const abort = new AbortController();
    return {
        id: row.id, key: row.run_key, userId: row.user_id, meta: row.meta as Meta,
        startedAt: new Date(row.started_at).getTime(), signal: abort.signal,
        get seq() { return Number(row.seq); },
        get finished() { return row.state === "finished" || row.state === "owner_lost"; },
        get stopped() { return row.state === "stopping"; },
        write: () => false, finish: () => {}, stop: () => {},
        subscribe(from, subscriber) {
            let detached = false;
            void (async () => {
                let cursor = from;
                let failures = 0;
                while (!detached) {
                    const current = await cluster.lookup(row.id);
                    if (!current || current.fence !== row.fence || current.state === "owner_lost") {
                        await subscriber.write(`data: ${JSON.stringify({ type: "error", detail: "The response owner became unavailable.", code: "owner_lost" })}\n\n`);
                        await subscriber.write("data: [DONE]\n\n");
                        break;
                    }
                    let page: RunPage;
                    try {
                        page = await cluster.request<RunPage>(row.owner_instance, "page", { id: row.id, fence: row.fence, from: cursor });
                        failures = 0;
                    } catch (error) {
                        if (++failures >= 3) throw error;
                        // A missed NOTIFY/reconnect never advances the cursor.
                        await new Promise((resolve) => setTimeout(resolve, 500));
                        continue;
                    }
                    for (const frame of page.frames) {
                        if (detached) break;
                        await subscriber.write(frame.chunk);
                    }
                    cursor = Math.max(cursor, page.next);
                    if (page.finished) break;
                    await new Promise((resolve) => setTimeout(resolve, page.frames.length ? 0 : 300));
                }
            })().catch(async () => {
                if (!detached) {
                    await subscriber.write(`data: ${JSON.stringify({ type: "error", detail: "Response replay is temporarily unavailable.", code: "stream_unavailable" })}\n\n`);
                    await subscriber.write("data: [DONE]\n\n");
                }
            }).finally(() => { if (!detached) subscriber.end(); });
            return () => { detached = true; };
        },
    };
}

export async function findStreamRun<Meta = Record<string, unknown>>(id: string): Promise<StreamRun<Meta> | undefined> {
    const cluster = streamRunCluster();
    if (!cluster) return getStreamRun(id);
    const row = await cluster.lookup(id);
    if (!row) return undefined;
    return row.owner_instance === cluster.instanceId && row.state !== "owner_lost"
        ? getStreamRun(id) : remoteRun<Meta>(row);
}

export async function findActiveStreamRun<Meta = Record<string, unknown>>(key: string): Promise<StreamRun<Meta> | null> {
    const cluster = streamRunCluster();
    if (!cluster) return getActiveStreamRun(key);
    const row = await cluster.active(key);
    if (!row) return null;
    return row.owner_instance === cluster.instanceId ? getActiveStreamRun(key) : remoteRun<Meta>(row);
}

export async function requestStreamRunStop(run: StreamRun<unknown>): Promise<boolean> {
    const cluster = streamRunCluster();
    if (!cluster) { run.stop(); return !run.finished; }
    const row = await cluster.lookup(run.id);
    if (!row || row.state === "finished" || row.state === "owner_lost") return false;
    const stopped = await cluster.stop(run.id, row.fence);
    if (!stopped || stopped.state !== "stopping") return false;
    if (row.owner_instance === cluster.instanceId) run.stop();
    return true;
}

/** Route/adapter seam: register only call routing metadata, never tool data. */
export async function registerStreamRunToolCall(run: StreamRun<unknown>, callId: string, userId: string, timeoutMs: number): Promise<void> {
    const cluster = streamRunCluster();
    if (!cluster) return;
    const local = runs.get(run.id);
    if (!local?.clusterRow || local.finished) throw new Error("Word turn owner lost");
    if (!await cluster.registerToolCall(local.clusterRow, callId, userId, timeoutMs))
        throw new Error("Word turn owner lost");
}

export function streamRunFenceArgs(runId: string): { p_run_id: string; p_owner_token: string; p_fence: string } | null {
    const row = runs.get(runId)?.clusterRow;
    if (!row) return null;
    return { p_run_id: row.id, p_owner_token: row.owner_token, p_fence: row.fence };
}

/** The run with this id, generating or retained. */
export function getStreamRun<Meta = Record<string, unknown>>(
    id: string,
): StreamRun<Meta> | undefined {
    return runs.get(id) as StreamRun<Meta> | undefined;
}

/**
 * The run registered under this key: the one generating, or — within the
 * retention window — the one that just ended. Callers that must distinguish
 * the two (a "is something running right now" report) check `finished`.
 */
export function getActiveStreamRun<Meta = Record<string, unknown>>(
    key: string,
): StreamRun<Meta> | null {
    return (runsByKey.get(key) as StreamRun<Meta> | undefined) ?? null;
}

/**
 * Stream a run into an Express response as SSE, from `from` onwards, and end
 * the response when the run finishes. Closing the response only detaches.
 *
 * Returns the same `{ signal, write, finish }` shape `openAssistantSse` gives
 * the streaming routes, so a route that starts a run drives the generation
 * through the run without changing anything else: `write` buffers and fans
 * out, `signal` is the run's (Stop, not socket close), `finish` ends the run.
 */
export function attachStreamRunSse(
    res: Response,
    run: StreamRun<unknown>,
    from = 1,
): {
    signal: AbortSignal;
    write: (line: string, opts?: StreamRunWriteOptions) => boolean;
    finish: () => void;
} {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    let ended = false;
    const detach = run.subscribe(from, {
        write: async (chunk) => {
            if (ended || res.writableEnded) return;
            if (res.writableLength > MAX_SSE_READER_QUEUE_BYTES) {
                ended = true;
                res.end(`data: ${JSON.stringify({ type: "error", code: "slow_reader", detail: "Response reader fell behind; reconnect to resume." })}\n\ndata: [DONE]\n\n`);
                return;
            }
            if (!res.write(chunk)) {
                try { await once(res, "drain"); }
                catch { /* client detached while backpressured */ }
            }
        },
        end: () => {
            if (ended) return;
            ended = true;
            res.end();
        },
    });
    res.on("close", () => {
        ended = true;
        detach();
    });

    return {
        signal: run.signal,
        write: run.write,
        finish: run.finish,
    };
}

/** Test hook: forget every run. */
export function resetStreamRunsForTests() {
    for (const run of [...runs.values()]) remove(run);
    runsByKey.clear();
}
