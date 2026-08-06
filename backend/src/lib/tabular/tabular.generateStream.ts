// Async + reconnectable variants of the tabular generate stream.
//
// Extraction is handed to durable BullMQ jobs (one per row) that retry and
// survive a client disconnect or server restart. The HTTP request becomes a
// *view* over that work: it subscribes to the review's Redis progress channel
// and forwards each cell update as the same `cell_update` SSE frame the
// synchronous path emits, with a DB-poll backstop so a dropped pub/sub message
// can never leave the stream hung.
//
// Two entry points share the `tailTabularRun` core:
//   - streamTabularGenerateAsync — POST /:reviewId/generate: enqueues the work,
//     then tails it.
//   - streamTabularRunView — GET /:reviewId/generate/stream: tails an already-
//     running (or already-finished) run without enqueuing, so a client that
//     dropped can reconnect and catch up.
//
// THE GENERATION LEASE. The route claims the lease (and so returns main's 409
// review_running / review_stale) before calling in here, then HANDS IT OVER:
// the work outlives the request, so the request must not release the lease on
// its way out. Instead every targeted cell is stamped with the generation id
// before the jobs are enqueued, each worker renews the lease while it processes,
// and whichever worker sees the last stamp cleared releases it
// (`finishGenerationIfIdle`). The two cases where no worker will ever run —
// nothing outstanding, or every enqueue failing — release the lease here.

import IORedis from "ioredis";
import type { Response } from "express";
import { REDIS_URL } from "../queue/connection";
import { startSseHeartbeat } from "../sseHeartbeat";
import { enqueueExtraction } from "../queue/extractionQueue";
import { runProgressChannel, type CellUpdate } from "../queue/runProgress";
import { type ReviewRow } from "./tabular.rows";
import {
    finishGeneration,
    parseCellContent,
    type Column,
    type Db,
    type Log,
} from "./tabular.shared";

/** How often the DB-poll backstop reconciles cell state (ms). */
const RECONCILE_INTERVAL_MS = 3_000;
/** Hard ceiling on a single stream so a vanished job can't hold it open forever. */
const STREAM_MAX_MS = 15 * 60 * 1000;

const cellKey = (rowId: string, columnIndex: number) =>
    `${rowId}:${columnIndex}`;

/**
 * Given the review's columns, its rows, and current cell state, compute the
 * set of cells that still need extracting and the rows that own at least one
 * of them. Pure and side-effect free so it can be unit-tested.
 */
export function targetPendingCells(
    columns: Column[],
    rows: { id: string }[],
    cellMap: Map<string, Record<string, unknown>>,
): { rowIds: string[]; pending: Set<string> } {
    const pending = new Set<string>();
    const rowIds: string[] = [];
    for (const row of rows) {
        const rowId = row.id;
        let hasPending = false;
        for (const col of columns) {
            const cell = cellMap.get(`${rowId}:${col.index}`);
            if (!(cell?.status === "done" && cell?.content)) {
                pending.add(cellKey(rowId, col.index));
                hasPending = true;
            }
        }
        if (hasPending) rowIds.push(rowId);
    }
    return { rowIds, pending };
}

/**
 * Stamp every cell this run intends to fill with its generation id, BEFORE any
 * job is enqueued. Two things depend on the stamp:
 *   - worker writes are guarded by it, so a superseded run cannot overwrite the
 *     winner's results;
 *   - it is how the workers detect that the run is finished — a row still
 *     waiting in the queue keeps its stamp, so nobody releases the lease early.
 * Cells that do not exist yet are inserted `pending` so they carry a stamp too.
 */
export async function claimCellsForGeneration(args: {
    db: Db;
    reviewId: string;
    generationId: string;
    columns: Column[];
    rows: ReviewRow[];
    cellMap: Map<string, Record<string, unknown>>;
}): Promise<void> {
    const { db, reviewId, generationId, columns, rows, cellMap } = args;
    const existingIds: string[] = [];
    const inserts: Record<string, unknown>[] = [];
    for (const row of rows) {
        for (const col of columns) {
            const cell = cellMap.get(cellKey(row.id, col.index));
            if (cell?.status === "done" && cell?.content) continue;
            if (cell?.id) {
                existingIds.push(cell.id as string);
            } else {
                inserts.push({
                    review_id: reviewId,
                    row_id: row.id,
                    document_id: row.document_id,
                    column_index: col.index,
                    status: "pending",
                    generation_id: generationId,
                });
            }
        }
    }
    if (existingIds.length) {
        const { error } = await db
            .from("tabular_cells")
            .update({ generation_id: generationId })
            .in("id", existingIds);
        if (error) throw new Error(error.message);
    }
    if (inserts.length) {
        const { error } = await db.from("tabular_cells").insert(inserts);
        if (error) throw new Error(error.message);
    }
}

/**
 * The shared streaming core: open the SSE response, subscribe to the review's
 * progress channel, run `afterSubscribe` (POST enqueues here; GET does not),
 * then forward cell updates — resolving each pending cell on a terminal status —
 * until every targeted cell is terminal, the client disconnects, or the cap
 * elapses. A DB-poll backstop reconciles missed messages.
 */
async function tailTabularRun(args: {
    res: Response;
    db: Db;
    reviewId: string;
    log: Log;
    pending: Set<string>;
    afterSubscribe?: () => Promise<void>;
}): Promise<void> {
    const { res, db, reviewId, log, pending, afterSubscribe } = args;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const stopHeartbeat = startSseHeartbeat(res);
    const write = (payload: unknown) => {
        try {
            if (!res.writableEnded)
                res.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch {
            // Client gone; the "close" handler will tear the stream down.
        }
    };

    let sub: IORedis | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let cap: ReturnType<typeof setTimeout> | null = null;
    let finished = false;

    const cleanup = () => {
        stopHeartbeat();
        if (poll) clearInterval(poll);
        if (cap) clearTimeout(cap);
        if (sub) void sub.quit().catch(() => {});
        sub = null;
    };
    // End the SSE response (client saw [DONE]). Any enqueued jobs keep running
    // regardless — this only closes the *view*.
    const finish = () => {
        if (finished) return;
        finished = true;
        try {
            if (!res.writableEnded) res.write("data: [DONE]\n\n");
        } catch {
            /* client already gone */
        }
        cleanup();
        if (!res.writableEnded) res.end();
    };
    // Client disconnected first: stop tailing but do NOT end (already closed),
    // and leave any workers running so the extraction still completes.
    const abandon = () => {
        if (finished) return;
        finished = true;
        cleanup();
    };

    // Terminal update for a pending cell: forward it and drop it from the set.
    const resolve = (key: string, update: CellUpdate) => {
        if (!pending.delete(key)) return;
        write(update);
        if (pending.size === 0) finish();
    };
    const onUpdate = (update: CellUpdate) => {
        const key = cellKey(update.row_id, update.column_index);
        if (update.status === "generating") {
            if (pending.has(key)) write(update); // spinner feedback; still pending
            return;
        }
        resolve(key, update); // "done" | "error"
    };

    res.on("close", abandon);

    // Nothing to do — every targeted cell is already done.
    if (pending.size === 0) return void finish();

    // Subscribe BEFORE enqueuing so a fast worker can't publish into the void.
    // Only when the async flag is on: the GET view is also reachable in
    // synchronous (no-Redis) deployments, where dialing Redis would hang the
    // stream — there the DB-poll backstop below does all the resolving.
    if (process.env.ASYNC_TABULAR_EXTRACTION === "true") {
        try {
            sub = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
            await sub.subscribe(runProgressChannel(reviewId));
            sub.on("message", (_channel, message) => {
                try {
                    onUpdate(JSON.parse(message) as CellUpdate);
                } catch {
                    /* ignore malformed frame */
                }
            });
        } catch (err) {
            log.error("[tabular/generate-async] subscribe failed", {
                err,
                reviewId,
            });
        }
    }

    if (afterSubscribe) await afterSubscribe();

    // Backstop: reconcile against the DB in case a pub/sub frame was missed (or,
    // for a reconnecting view, to replay progress that happened while away).
    poll = setInterval(() => {
        if (finished) return;
        void (async () => {
            const { data: cells } = await db
                .from("tabular_cells")
                .select("row_id, column_index, status, content")
                .eq("review_id", reviewId);
            for (const c of (cells ?? []) as {
                row_id: string;
                column_index: number;
                status: string;
                content: unknown;
            }[]) {
                const key = cellKey(c.row_id, c.column_index);
                if (!pending.has(key)) continue;
                if (c.status === "done" && c.content) {
                    resolve(key, {
                        type: "cell_update",
                        row_id: c.row_id,
                        column_index: c.column_index,
                        content: parseCellContent(c.content),
                        status: "done",
                    });
                } else if (c.status === "error") {
                    resolve(key, {
                        type: "cell_update",
                        row_id: c.row_id,
                        column_index: c.column_index,
                        content: null,
                        status: "error",
                    });
                }
            }
        })().catch((err) =>
            log.error("[tabular/generate-async] reconcile poll failed", {
                err,
                reviewId,
            }),
        );
    }, RECONCILE_INTERVAL_MS);
    if (typeof poll.unref === "function") poll.unref();

    cap = setTimeout(finish, STREAM_MAX_MS);
    if (typeof cap.unref === "function") cap.unref();
}

/**
 * Wait for one cell to reach a terminal state — the "view" half of an
 * async regenerate-cell. The job is already enqueued; this subscribes to the
 * review's progress channel (flag on) and polls the DB as a backstop, then
 * returns the cell's terminal content, or null if `timeoutMs` elapses first
 * (the job keeps running — the caller reports "still generating").
 *
 * Read-only with respect to the generation lease: the worker owns it, renews it
 * while it extracts, and releases it via `finishGenerationIfIdle` once the cell
 * goes terminal. This function must never write cell state or finish the lease
 * — a timeout here says nothing about the job, which is still running.
 */
export async function awaitCellTerminal(args: {
    db: Db;
    reviewId: string;
    rowId: string;
    columnIndex: number;
    log: Log;
    timeoutMs?: number;
    pollMs?: number;
}): Promise<
    | { status: "done"; content: ReturnType<typeof parseCellContent> }
    | { status: "error" }
    | null
> {
    const { db, reviewId, rowId, columnIndex, log } = args;
    const timeoutMs = args.timeoutMs ?? 120_000;
    const pollMs = args.pollMs ?? 1_000;

    let sub: IORedis | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    try {
        return await new Promise((resolve) => {
            let settled = false;
            const settle = (
                value:
                    | {
                          status: "done";
                          content: ReturnType<typeof parseCellContent>;
                      }
                    | { status: "error" }
                    | null,
            ) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };

            const checkDb = async () => {
                const { data: cell } = await db
                    .from("tabular_cells")
                    .select("status, content")
                    .eq("review_id", reviewId)
                    .eq("row_id", rowId)
                    .eq("column_index", columnIndex)
                    .maybeSingle();
                if (!cell) return;
                if (cell.status === "done" && cell.content)
                    settle({
                        status: "done",
                        content: parseCellContent(cell.content),
                    });
                else if (cell.status === "error") settle({ status: "error" });
            };

            if (process.env.ASYNC_TABULAR_EXTRACTION === "true") {
                try {
                    sub = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
                    void sub
                        .subscribe(runProgressChannel(reviewId))
                        .catch(() => {});
                    sub.on("message", (_channel, message) => {
                        try {
                            const update = JSON.parse(message) as CellUpdate;
                            if (
                                update.row_id !== rowId ||
                                update.column_index !== columnIndex
                            )
                                return;
                            if (update.status === "done")
                                settle({
                                    status: "done",
                                    content: update.content as ReturnType<
                                        typeof parseCellContent
                                    >,
                                });
                            else if (update.status === "error")
                                settle({ status: "error" });
                        } catch {
                            /* ignore malformed frame */
                        }
                    });
                } catch (err) {
                    log.error("[tabular/regenerate-async] subscribe failed", {
                        err,
                        reviewId,
                    });
                }
            }

            poll = setInterval(() => {
                void checkDb().catch((err) =>
                    log.error("[tabular/regenerate-async] poll failed", {
                        err,
                        reviewId,
                    }),
                );
            }, pollMs);
            if (typeof poll.unref === "function") poll.unref();
            timer = setTimeout(() => settle(null), timeoutMs);
            if (typeof timer.unref === "function") timer.unref();
        });
    } finally {
        if (poll) clearInterval(poll);
        if (timer) clearTimeout(timer);
        if (sub) void (sub as IORedis).quit().catch(() => {});
    }
}

/**
 * POST /:reviewId/generate — enqueue the outstanding work, then tail it.
 *
 * The caller has already claimed the generation lease. Resolves to `true` once
 * responsibility for that lease has moved off the request (either to the
 * workers, or because this function released it itself), which tells the route
 * not to release it in its own `finally`. A throw leaves the lease with the
 * route, which then releases it.
 */
export async function streamTabularGenerateAsync(args: {
    res: Response;
    db: Db;
    reviewId: string;
    userId: string;
    generationId: string;
    columns: Column[];
    rows: ReviewRow[];
    cellMap: Map<string, Record<string, unknown>>;
    log: Log;
}): Promise<boolean> {
    const { res, db, reviewId, userId, generationId, columns, rows, cellMap, log } =
        args;
    const { rowIds, pending } = targetPendingCells(columns, rows, cellMap);

    // Nothing outstanding: no worker will ever run, so release the lease here
    // rather than leaving the review "running" until the lease expires.
    if (pending.size === 0) {
        await finishGeneration(
            db,
            reviewId,
            generationId,
            log,
            "[tabular/generate-async]",
        );
        await tailTabularRun({ res, db, reviewId, log, pending });
        return true;
    }

    await claimCellsForGeneration({
        db,
        reviewId,
        generationId,
        columns,
        rows,
        cellMap,
    });

    let enqueued = 0;
    await tailTabularRun({
        res,
        db,
        reviewId,
        log,
        pending,
        afterSubscribe: async () => {
            for (const rowId of rowIds) {
                try {
                    await enqueueExtraction({
                        reviewId,
                        userId,
                        rowId,
                        generationId,
                    });
                    enqueued++;
                } catch (err) {
                    log.error("[tabular/generate-async] enqueue failed", {
                        err,
                        reviewId,
                        rowId,
                    });
                }
            }
        },
    });

    // Every enqueue failed (Redis down, say): nothing will renew or release the
    // lease, so hand the review back now instead of waiting for the expiry.
    if (enqueued === 0) {
        await finishGeneration(
            db,
            reviewId,
            generationId,
            log,
            "[tabular/generate-async]",
        );
    }
    return true;
}

/**
 * GET /:reviewId/generate/stream — reconnect to an in-flight (or finished) run
 * without re-triggering work. Pure observer: it tails progress and catches up
 * from the DB, so a client that dropped mid-run can resume. It takes NO lease —
 * watching a run must never be able to block the run itself.
 */
export async function streamTabularRunView(args: {
    res: Response;
    db: Db;
    reviewId: string;
    columns: Column[];
    rows: ReviewRow[];
    cellMap: Map<string, Record<string, unknown>>;
    log: Log;
}): Promise<void> {
    const { res, db, reviewId, columns, rows, cellMap, log } = args;
    const { pending } = targetPendingCells(columns, rows, cellMap);
    await tailTabularRun({ res, db, reviewId, log, pending });
}
