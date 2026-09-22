// The DB-queue runner: polls public.db_jobs, executes handlers, applies the
// retry/backoff state machine, and sweeps old rows.
//
// Runs BY DEFAULT in every deployment â€” the whole point of this queue is
// durability without new infrastructure, so unlike the Redis workers there is
// no opt-in flag; DB_JOBS_ENABLED=false exists only as an operational escape
// hatch â€” and it is honored on BOTH sides. The runner stops, and producers
// stop acknowledging work nothing will run: account deletion and async
// exports answer 503. "Enqueue anyway and let it wait" was the old reading,
// and it could acknowledge erasure that never happened. Split worker
// topology is WORKERS_MODE=none, not this
// flag. Polling a partial index every few seconds costs one cheap indexed
// query, and FOR UPDATE SKIP LOCKED in the claim RPC makes any number of
// backend replicas partition the work safely.

import { createServerSupabase } from "../supabase";
import { jobErrorMessage } from "./jobError";
import { deleteFile } from "../storage";
import { enqueueAppJobDelivery } from "../queue/appJobsQueue";
import { redisEnabled } from "./driver";
import {
    DbJobDeferredError,
    type Db,
    type DbJob,
    type DbJobHandlers,
} from "./types";
import { reportError } from "../observability/sentry";

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
/**
 * A "running" job whose claim is older than this is presumed crashed.
 * Exported because a handler that claims sibling rows of its own kind (the
 * document.cleanup coalescer) has to use the same stale threshold this loop
 * does, or the two disagree about who owns a row.
 */
export const STALE_SECONDS = 600;
/** Retention: how long finished rows are kept for inspection. */
const DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const FAILED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
const RETRY_UNTIL_SUCCESS_KINDS = new Set(["storage.cleanup", "document.cleanup"]);

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
 * "failed" â€” kinds whose failure must also flip domain state (a document to
 * "error", a row's cells to "error") register a hook here. Hook errors are
 * contained: the row still lands in "failed" for inspection.
 */
export type DbJobFailureHook = (db: Db, job: DbJob) => Promise<void>;


/**
 * "Retrying cannot fix this." A handler throws it when the job is refused by
 * a rule, not defeated by a transient fault â€” and the state machine skips
 * straight to `failed`, the same way an unknown kind does.
 *
 * The retry budget is for flaky networks and busy databases. Spending 20
 * attempts over hours on a job the domain will refuse identically every time
 * (account deletion for the only admin of an organization that still has
 * members) buries the real reason under a wall of repeats and leaves the
 * user's request in limbo far longer than it needs to be.
 */
export class NonRetryableJobError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "NonRetryableJobError";
    }
}

/**
 * Run one claimed job through its handler and persist the outcome:
 *   handler resolves        -> done (+ optional result)
 *   handler throws, retries -> pending again with run_at pushed back
 *   handler throws, spent   -> failed (terminal, kept for inspection)
 *   handler throws NonRetryableJobError -> failed immediately
 *   unknown kind            -> failed immediately (retrying can't fix it)
 * Exported for unit tests; the poll loop below is just claim + fan-in.
 */
export async function processClaimedJob(
    db: Db,
    handlers: DbJobHandlers,
    job: DbJob,
    failureHooks: Readonly<Record<string, DbJobFailureHook>> = {},
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

    const retryUntilSuccess = RETRY_UNTIL_SUCCESS_KINDS.has(job.kind);
    const handler = handlers[job.kind];
    if (!handler) {
        clearInterval(heartbeat);
        // During a rolling deploy, an older worker may claim a cleanup job
        // before it knows the handler. Keep private object cleanup retryable.
        await finish(
            retryUntilSuccess ? "pending" : "failed",
            `unknown job kind: ${job.kind}`,
            null,
            retryUntilSuccess ? new Date(Date.now() + 60_000).toISOString() : null,
        );
        reportError(new Error(`Unknown db_jobs kind: ${job.kind}`), {
            tags: { component: "dbq", job_kind: job.kind },
            extra: { job_id: job.id },
            fingerprint: ["dbq-unknown-kind", job.kind],
        });
        console.error("[dbq] unknown job kind", { id: job.id, kind: job.kind });
        return;
    }

    try {
        if (!handler) throw new Error(`unknown job kind: ${job.kind}`);
        const result = await handler(db, job);
        clearInterval(heartbeat);
        if (!await finish("done", null, result ?? null))
            console.warn("[dbq] claim lost before completion", { id: job.id });
    } catch (err) {
        clearInterval(heartbeat);
        const message = jobErrorMessage(err);
        // Destructive memory operations remove version metadata only after a
        // cleanup job owns the object path. That job is the last durable
        // pointer, so storage cleanup must retry until success rather than
        // becoming a finite-attempt failed row that a later sweep can erase.
        // A NonRetryableJobError is the handler saying the job can never
        // succeed, which wins over both the retry budget and retry-until-success.
        const deferred = err instanceof DbJobDeferredError;
        const spent =
            err instanceof NonRetryableJobError ||
            (!deferred &&
                job.attempts >= job.max_attempts &&
                !retryUntilSuccess);
        const deferredAt = deferred ? Date.parse(err.runAt) : Number.NaN;
        const delayMs = deferred
            ? Math.max(1_000, (Number.isFinite(deferredAt) ? deferredAt : Date.now() + 60_000) - Date.now())
            : retryDelayMs(job.attempts);
        const runAt = new Date(Date.now() + delayMs).toISOString();
        const owned = deferred
            ? await (async () => {
                if (leaseLost) return false;
                const { data, error } = await db.rpc("defer_db_job", {
                    ...identity, p_run_at: runAt, p_reason: message,
                });
                if (error) throw new Error(`Unable to defer DB job: ${error.message}`);
                return data === true;
              })()
            : await finish(spent ? "failed" : "pending", message, null, spent ? null : runAt);
        if (!owned) {
            console.warn("[dbq] claim lost before retry transition", { id: job.id });
            return;
        }
        if (spent) {
            const hook = failureHooks[job.kind];
            if (hook) {
                try {
                    await hook(db, job);
                } catch (hookErr) {
                    reportError(hookErr, {
                        tags: { component: "dbq", job_kind: job.kind, stage: "failure-hook" },
                        extra: { job_id: job.id },
                    });
                    console.error("[dbq] failure hook crashed", {
                        id: job.id,
                        kind: job.kind,
                        hookErr,
                    });
                }
            }
        } else if (redisEnabled()) {
            // Redeliver the retry at its backoff time so it doesn't wait for
            // the (slow, backstop-cadence) poller. Best-effort â€” the poller
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
        // Every failed attempt is reported — a bug shows up on attempt one,
        // not after the backoff ladder has burned an hour. Retryable attempts
        // are warnings; the terminal failure is the error, and both group per
        // job kind so one bad handler is one issue with a hit count. A
        // deferral is the handler asking to run later, not a failure, so it
        // is logged but never reported.
        if (!deferred) {
            reportError(err, {
                level: spent ? "error" : "warning",
                tags: {
                    component: "dbq",
                    job_kind: job.kind,
                    attempt: job.attempts,
                    max_attempts: job.max_attempts,
                    terminal: spent,
                },
                extra: { job_id: job.id, dedupe_key: job.dedupe_key ?? null },
            });
        }
        console.error(
            deferred
                ? "[dbq] job deferred"
                : spent
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
    failureHooks: Readonly<Record<string, DbJobFailureHook>> = {},
): Promise<number> {
    const { data, error } = await db.rpc("claim_db_jobs", {
        p_limit: CLAIM_BATCH,
        p_stale_seconds: STALE_SECONDS,
    });
    if (error) {
        // Table/function missing (migration not applied yet) or transient DB
        // trouble: log and try again next tick — never crash the server.
        reportError(new Error(`db_jobs claim failed: ${error.message}`), {
            tags: { component: "dbq", stage: "claim" },
            fingerprint: ["dbq-claim-failed"],
        });
        console.error("[dbq] claim failed", error.message);
        return 0;
    }
    const jobs = (data ?? []) as DbJob[];
    // allSettled defensively: processClaimedJob handles its own errors, but
    // one job's unexpected rejection must never abandon the rest of a batch.
    const outcomes = await Promise.allSettled(
        jobs.map((job) => processClaimedJob(db, handlers, job, failureHooks)),
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
 * the row goes (the row's result is the only pointer to the file â€” deleting
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

    // 1. Expire export artifacts (their download links stop working here â€”
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

    // 2. Drop old finished rows â€” EXCEPT export.build. Step 1 is the only
    //    deleter of done export rows because it removes the storage object
    //    before the row: a row it kept after a failed file delete is retry
    //    state, and this generic purge sweeping it at the 7-day boundary
    //    would erase the only pointer to the artifact and leak a full copy
    //    of the user's data â€” the exact leak the docstring above promises
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
        .neq("kind", "document.cleanup")
        .lt("finished_at", failedCutoff);

    // 3. Curator receipts. memory_consolidation_results rows exist so a
    //    retried memory.consolidate job applies each scope once; they are
    //    useless after the job row itself has been swept, and nothing else
    //    deletes them.
    await db
        .from("memory_consolidation_results")
        .delete()
        .lt("created_at", doneCutoff);
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
export function startDbJobRunner(handlers: DbJobHandlers, failureHooks: Readonly<Record<string, DbJobFailureHook>> = {}): void {
    if (!dbJobsEnabled()) {
        console.log("[dbq] disabled via DB_JOBS_ENABLED=false");
        return;
    }
    if (pollTimer) return;
    const db = createServerSupabase();

    const tick = () => {
        if (inFlight) return;
        inFlight = runDbJobTick(db, handlers, failureHooks)
            .catch((err) => {
                reportError(err, { tags: { component: "dbq", stage: "tick" } });
                console.error("[dbq] tick failed", err);
            })
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
        void runDbJobRetentionSweep(db).catch((err) => {
            reportError(err, { tags: { component: "dbq", stage: "retention" } });
            console.error("[dbq] retention sweep failed", err);
        });
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
