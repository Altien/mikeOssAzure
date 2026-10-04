// The DB-queue runner: polls public.db_jobs, executes handlers, applies the
// retry/backoff state machine, and sweeps old rows.
//
// Runs BY DEFAULT in every deployment — the whole point of this queue is
// durability without new infrastructure, so unlike the Redis workers there is
// no opt-in flag; DB_JOBS_ENABLED=false exists only as an operational escape
// hatch — and it is honored on BOTH sides. The runner stops, and producers
// stop acknowledging work nothing will run: account deletion and async
// exports answer 503. "Enqueue anyway and let it wait" was the old reading,
// and it could acknowledge erasure that never happened. Split worker
// topology is WORKERS_MODE=none, not this
// flag. Polling a partial index every few seconds costs one cheap indexed
// query, and FOR UPDATE SKIP LOCKED in the claim RPC makes any number of
// backend replicas partition the work safely.

import { createServerSupabase } from "../supabase";
import { deleteFile } from "../storage";
import { enqueueAppJobDelivery } from "../queue/appJobsQueue";
import { redisEnabled } from "./driver";
import type { Db, DbJob, DbJobHandlers } from "./types";

/**
 * Poll cadence depends on the driver: with Redis configured, BullMQ delivers
 * jobs instantly and the poller is only a BACKSTOP for lost deliveries, so
 * it idles at 60s; without Redis the poller IS the delivery mechanism and
 * runs every 5s. DB_JOBS_POLL_MS overrides either.
 */
function pollMs(): number {
    const raw = Number(process.env.DB_JOBS_POLL_MS);
    if (Number.isFinite(raw) && raw >= 250) return raw;
    return redisEnabled() ? 60_000 : 5_000;
}
const CLAIM_BATCH = 5;
/** A "running" job whose claim is older than this is presumed crashed. */
const STALE_SECONDS = 600;
/** Retention: how long finished rows are kept for inspection. */
const DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const FAILED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;

/**
 * Exponential backoff for retries: 30s, 90s, 270s, ... capped at 30 min.
 * `attempts` is the attempt that just failed (claim increments it), so the
 * first retry waits 30s.
 */
export function retryDelayMs(attempts: number): number {
    const base = 30_000 * Math.pow(3, Math.max(0, attempts - 1));
    return Math.min(base, 30 * 60 * 1000);
}

/**
 * Domain cleanup to run when a kind's job fails PERMANENTLY (attempts
 * exhausted). The generic state machine only flips the db_jobs row to
 * "failed" — kinds whose failure must also flip domain state (a document to
 * "error", a row's cells to "error") register a hook here. Hook errors are
 * contained: the row still lands in "failed" for inspection.
 */
export type DbJobFailureHook = (db: Db, job: DbJob) => Promise<void>;
export const DB_JOB_FAILURE_HOOKS: Record<string, DbJobFailureHook> = {};

/**
 * Run one claimed job through its handler and persist the outcome:
 *   handler resolves        -> done (+ optional result)
 *   handler throws, retries -> pending again with run_at pushed back
 *   handler throws, spent   -> failed (terminal, kept for inspection)
 *   unknown kind            -> failed immediately (retrying can't fix it)
 * Exported for unit tests; the poll loop below is just claim + fan-in.
 */
export async function processClaimedJob(
    db: Db,
    handlers: DbJobHandlers,
    job: DbJob,
): Promise<void> {
    // A UUID is stable across PostgREST/JavaScript timestamp precision loss.
    // SQL renews lease_expires_at and finishes only this claim token.
    if (!job.claim_token) throw new Error("DB job claim has no fence token");
    const identity = {
        p_id: job.id,
        p_attempts: job.attempts,
        p_claim_token: job.claim_token,
    };
    let leaseLost = false;
    let renewing = false;
    const deadline = Date.now() + 30 * 60_000;
    const heartbeat = setInterval(() => {
        if (renewing || leaseLost) return;
        if (Date.now() >= deadline) {
            leaseLost = true;
            return;
        }
        renewing = true;
        void Promise.resolve(db.rpc("renew_db_job", {
            ...identity,
            p_lease_seconds: STALE_SECONDS,
        })).then(({ data, error }) => {
            if (error || data !== true) leaseLost = true;
        }).catch(() => { leaseLost = true; }).finally(() => { renewing = false; });
    }, 60_000);
    heartbeat.unref?.();
    const finish = async (
        status: "done" | "pending" | "failed",
        lastError: string | null = null,
        result: Record<string, unknown> | null = null,
        runAt: string | null = null,
    ): Promise<boolean> => {
        if (leaseLost) return false;
        const { data, error } = await db.rpc("finish_db_job", {
            ...identity,
            p_status: status,
            p_last_error: lastError,
            p_result: result,
            p_run_at: runAt,
        });
        if (error) throw new Error(`Unable to finish DB job: ${error.message}`);
        return data === true;
    };

    const handler = handlers[job.kind];
    if (!handler) {
        clearInterval(heartbeat);
        await finish("failed", `unknown job kind: ${job.kind}`);
        console.error("[dbq] unknown job kind", { id: job.id, kind: job.kind });
        return;
    }

    try {
        const result = await handler(db, job);
        clearInterval(heartbeat);
        if (!await finish("done", null, result ?? null))
            console.warn("[dbq] claim lost before completion", { id: job.id });
    } catch (err) {
        clearInterval(heartbeat);
        const message =
            err instanceof Error ? err.message : String(err ?? "unknown");
        const spent = job.attempts >= job.max_attempts;
        const delayMs = retryDelayMs(job.attempts);
        const owned = await finish(
            spent ? "failed" : "pending", message, null,
            spent ? null : new Date(Date.now() + delayMs).toISOString(),
        );
        if (!owned) {
            console.warn("[dbq] claim lost before retry transition", { id: job.id });
            return;
        }
        if (spent) {
            const hook = DB_JOB_FAILURE_HOOKS[job.kind];
            if (hook) {
                try {
                    await hook(db, job);
                } catch (hookErr) {
                    console.error("[dbq] failure hook crashed", {
                        id: job.id,
                        kind: job.kind,
                        hookErr,
                    });
                }
            }
        } else if (redisEnabled()) {
            // Redeliver the retry at its backoff time so it doesn't wait for
            // the (slow, backstop-cadence) poller. Best-effort — the poller
            // covers a failed redelivery.
            try {
                await enqueueAppJobDelivery(job.id, {
                    delayMs,
                    attempt: job.attempts,
                });
            } catch (redeliverErr) {
                console.error(
                    "[dbq] retry redelivery failed; poll backstop will run it:",
                    redeliverErr instanceof Error
                        ? redeliverErr.message
                        : redeliverErr,
                );
            }
        }
        console.error(
            spent
                ? "[dbq] job permanently failed"
                : "[dbq] job failed; will retry",
            { id: job.id, kind: job.kind, attempts: job.attempts, message },
        );
    }
}

/** One poll tick: claim a batch and run every claimed job to completion. */
export async function runDbJobTick(
    db: Db,
    handlers: DbJobHandlers,
): Promise<number> {
    const { data, error } = await db.rpc("claim_db_jobs", {
        p_limit: CLAIM_BATCH,
        p_stale_seconds: STALE_SECONDS,
    });
    if (error) {
        // Table/function missing (migration not applied yet) or transient DB
        // trouble: log and try again next tick — never crash the server.
        console.error("[dbq] claim failed", error.message);
        return 0;
    }
    const jobs = (data ?? []) as DbJob[];
    // allSettled defensively: processClaimedJob handles its own errors, but
    // one job's unexpected rejection must never abandon the rest of a batch.
    const outcomes = await Promise.allSettled(
        jobs.map((job) => processClaimedJob(db, handlers, job)),
    );
    for (const [index, outcome] of outcomes.entries()) {
        if (outcome.status === "rejected") {
            console.error("[dbq] job transition failed", {
                id: jobs[index]?.id,
                reason: outcome.reason instanceof Error ? outcome.reason.message : "unknown",
            });
        }
    }
    return jobs.length;
}

/**
 * Retention sweep. Export artifacts get their storage object removed before
 * the row goes (the row's result is the only pointer to the file — deleting
 * it first would leak the object forever).
 */
export async function runDbJobRetentionSweep(
    db: Db,
    opts?: {
        deleteStoredFile?: (path: string) => Promise<void>;
        exportRetentionMs?: number;
    },
): Promise<void> {
    const deleteStoredFile = opts?.deleteStoredFile ?? deleteFile;
    const exportRetentionMs =
        opts?.exportRetentionMs ?? 24 * 60 * 60 * 1000;

    // 1. Expire export artifacts (their download links stop working here —
    //    documented as a 24h availability window).
    const exportCutoff = new Date(Date.now() - exportRetentionMs).toISOString();
    const { data: expired } = await db
        .from("db_jobs")
        .select("id, result")
        .eq("kind", "export.build")
        .eq("status", "done")
        .lt("finished_at", exportCutoff)
        .limit(100);
    for (const row of (expired ?? []) as Pick<DbJob, "id" | "result">[]) {
        const path = row.result?.storage_path;
        if (typeof path === "string" && path.length > 0) {
            try {
                await deleteStoredFile(path);
            } catch (err) {
                // Keep the row so the next sweep retries the file delete.
                console.error("[dbq] export artifact delete failed", {
                    id: row.id,
                    err,
                });
                continue;
            }
        }
        await db.from("db_jobs").delete().eq("id", row.id);
    }

    // 2. Drop old finished rows — EXCEPT export.build. Step 1 is the only
    //    deleter of done export rows because it removes the storage object
    //    before the row: a row it kept after a failed file delete is retry
    //    state, and this generic purge sweeping it at the 7-day boundary
    //    would erase the only pointer to the artifact and leak a full copy
    //    of the user's data — the exact leak the docstring above promises
    //    not to commit.
    const doneCutoff = new Date(Date.now() - DONE_RETENTION_MS).toISOString();
    await db
        .from("db_jobs")
        .delete()
        .eq("status", "done")
        .neq("kind", "export.build")
        .lt("finished_at", doneCutoff);
    const failedCutoff = new Date(
        Date.now() - FAILED_RETENTION_MS,
    ).toISOString();
    await db
        .from("db_jobs")
        .delete()
        .eq("status", "failed")
        .neq("kind", "storage.cleanup")
        .neq("kind", "account.delete")
        .lt("finished_at", failedCutoff);
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<unknown> | null = null;

export function dbJobsEnabled(): boolean {
    return process.env.DB_JOBS_ENABLED !== "false";
}

/**
 * Start the poll loop (idempotent). Ticks never overlap: a tick that is
 * still running when the next interval fires simply skips that interval.
 */
export function startDbJobRunner(handlers: DbJobHandlers): void {
    if (!dbJobsEnabled()) {
        console.log("[dbq] disabled via DB_JOBS_ENABLED=false");
        return;
    }
    if (pollTimer) return;
    const db = createServerSupabase();

    const tick = () => {
        if (inFlight) return;
        inFlight = runDbJobTick(db, handlers)
            .catch((err) => console.error("[dbq] tick failed", err))
            .finally(() => {
                inFlight = null;
            });
    };
    pollTimer = setInterval(tick, pollMs());
    pollTimer.unref();
    // First tick shortly after boot so work queued before a restart resumes
    // without waiting a full interval.
    setTimeout(tick, 1_000).unref();

    const sweep = () =>
        void runDbJobRetentionSweep(db).catch((err) =>
            console.error("[dbq] retention sweep failed", err),
        );
    sweepTimer = setInterval(sweep, SWEEP_EVERY_MS);
    sweepTimer.unref();
    setTimeout(sweep, 60_000).unref();

    console.log(
        `[dbq] runner started (poll ${pollMs()}ms, driver ${redisEnabled() ? "redis" : "postgres"})`,
    );
}

/** Stop polling and wait for the in-flight tick to finish (shutdown path). */
export async function stopDbJobRunner(): Promise<void> {
    if (pollTimer) clearInterval(pollTimer);
    if (sweepTimer) clearInterval(sweepTimer);
    pollTimer = null;
    sweepTimer = null;
    if (inFlight) await inFlight;
}
