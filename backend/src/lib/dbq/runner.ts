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

import { AppError } from "../appError";
import { createPlatformSupabase, createServerSupabase } from "../supabase";
import { runWithJobTenant } from "../tenantContext";
import { withLogContext } from "../logging/contextLight";
import { log } from "../logging/root";
import { jobErrorMessage } from "./jobError";
import { runIsolated } from "./jobScope";
import { deleteFile } from "../storage";
import { mapWithConcurrency } from "../concurrency";
import { mutateInBatches } from "../batchedQuery";

/** Object deletes in flight at once, per sweep or cleanup. */
const STORAGE_DELETE_CONCURRENCY = 8;
import { enqueueAppJobDelivery } from "../queue/appJobsQueue";
import { redisEnabled } from "./driver";
import {
    DbJobDeferredError,
    type Db,
    type DbJob,
    type DbJobHandlers,
} from "./types";
import { reportError, setOperation } from "../observability/sentry";
import {
    createPollFailureGate,
    type PollFailureGate,
} from "../observability/pollFailureGate";
import { asReportableError } from "../httpError";

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
/** Ceiling for the claim interval while every claim keeps failing. */
const CLAIM_MAX_BACKOFF_MS = 60_000;

/**
 * The claim fails identically on every tick while its cause lasts (RPC
 * missing because migrations were not applied, database unreachable). One
 * report per failure class, quiet repeats with a once-a-minute count, and a
 * backed-off poll — reporting every tick filed 1,167 events plus 1,227
 * console duplicates from one worker thread (MIKE-BACKEND-P / -3).
 */
export function createDbJobClaimGate(): PollFailureGate {
    return createPollFailureGate({
        label: "[dbq] claim",
        baseDelayMs: pollMs,
        maxDelayMs: CLAIM_MAX_BACKOFF_MS,
    });
}
const defaultClaimGate = createDbJobClaimGate();

const CLAIM_BATCH = 5;
/**
 * Per-tenant cap on live jobs across every worker and replica (multi-tenant
 * issue 017, migration 0184), or undefined for no cap. claim_db_jobs always
 * picks round-robin across tenants; the cap is opt-in so single-tenant
 * installs claim exactly as before.
 */
export function tenantConcurrencyCap(env: NodeJS.ProcessEnv = process.env): number | undefined {
    const raw = Number.parseInt(env.DBQ_TENANT_CONCURRENCY ?? "", 10);
    return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}
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
/** Expired export rows read per query, and the per-sweep ceiling (50,000 rows). */
const EXPORT_EXPIRY_BATCH = 100;
const EXPORT_EXPIRY_MAX_BATCHES = 500;
const RETRY_UNTIL_SUCCESS_KINDS = new Set(["storage.cleanup", "document.cleanup", "tenant.purge"]);

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
 * (account deletion for the only owner of an organization that still has
 * members) buries the real reason under a wall of repeats and leaves the
 * user's request in limbo far longer than it needs to be.
 */
export class NonRetryableJobError extends AppError {
    constructor(message: string) {
        super("dbq.non_retryable", message);
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
 *
 * The whole run — handler, lease renewals, the outcome write and any failure
 * hook — happens as the job's tenant (multi-tenant issue 003), so the
 * handler's queries carry the same tenant claim as the request that queued it.
 * Lease renewals and the outcome write (renew/finish/defer_db_job) go through
 * `controlDb`, the platform client in production: tenant_app may not call the
 * job-control functions (issue 008).
 */
async function runClaimedJob(
    db: Db,
    handlers: DbJobHandlers,
    job: DbJob,
    failureHooks: Readonly<Record<string, DbJobFailureHook>>,
    controlDb: Db,
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
        void Promise.resolve(controlDb.rpc("renew_db_job", {
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
        const { data, error } = await controlDb.rpc("finish_db_job", {
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
        setOperation("jobs.dispatch");
        clearInterval(heartbeat);
        // During a rolling deploy, an older worker may claim a cleanup job
        // before it knows the handler. Keep private object cleanup retryable.
        await finish(
            retryUntilSuccess ? "pending" : "failed",
            `unknown job kind: ${job.kind}`,
            null,
            retryUntilSuccess ? new Date(Date.now() + 60_000).toISOString() : null,
        );
        const unknownKind = new AppError("dbq.unknown_job_kind", `Unknown db_jobs kind: ${job.kind}`);
        reportError(unknownKind, {
            tags: { component: "dbq", job_kind: job.kind },
            extra: { job_id: job.id },
            fingerprint: ["dbq-unknown-kind", job.kind],
        });
        // Carry the reported object so the console bridge files no duplicate.
        console.error("[dbq] unknown job kind", {
            id: job.id,
            kind: job.kind,
            error: unknownKind,
        });
        return;
    }

    let unpublishedResult: Record<string, unknown> | void;
    let publicationUncertain = false;
    const discardUnpublished = async () => {
        if (!unpublishedResult || !handler.onUnpublishedResult) return;
        try {
            await handler.onUnpublishedResult(db, job, unpublishedResult, { publicationUncertain });
            unpublishedResult = undefined;
        } catch (cleanupError) {
            // An unknown publication outcome is not permission to delete.
            reportError(cleanupError, { tags: { component: "dbq", job_kind: job.kind, stage: "failure-hook" }, extra: { job_id: job.id } });
        }
    };
    const jobEvent = (phase: "start" | "done" | "retry" | "defer" | "failed", delayMs: number | null, lost: boolean) =>
        log().debug("dbq.job", {
            jobKind: job.kind, attempts: job.attempts, maxAttempts: job.max_attempts,
            phase, delayMs, leaseLost: lost,
        });
    try {
        if (!handler) throw new AppError("dbq.unknown_job_kind", `unknown job kind: ${job.kind}`);
        jobEvent("start", null, false);
        const result = await handler(db, job);
        unpublishedResult = result;
        clearInterval(heartbeat);
        publicationUncertain = true;
        const published = await finish("done", null, result ?? null);
        publicationUncertain = false;
        jobEvent("done", null, !published);
        if (!published) {
            console.warn("[dbq] claim lost before completion", { id: job.id });
            await discardUnpublished();
        } else {
            unpublishedResult = undefined;
        }
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
                const { data, error } = await controlDb.rpc("defer_db_job", {
                    ...identity, p_run_at: runAt, p_reason: message,
                });
                if (error) throw new Error(`Unable to defer DB job: ${error.message}`);
                return data === true;
              })()
            : await finish(spent ? "failed" : "pending", message, null, spent ? null : runAt);
        jobEvent(deferred ? "defer" : spent ? "failed" : "retry", spent ? null : delayMs, !owned);
        // This follows the fenced retry/terminal transition: a lost response
        // from finish(done) is reconciled by the handler before cleanup.
        if (owned) publicationUncertain = false;
        await discardUnpublished();
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
        // A handler can reject with a PostgREST plain object: give it a stack
        // and keep its code on the cause chain (failure_code), as the claim
        // path does. Errors pass through unchanged.
        const reportable = asReportableError(err, runClaimedJob);
        if (!deferred) {
            reportError(reportable, {
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
        const summary = { id: job.id, kind: job.kind, attempts: job.attempts, message };
        if (deferred) {
            // Not a failure, and not reported: console.error would reach
            // Sentry through the console bridge as an error event.
            console.log("[dbq] job deferred", summary);
        } else {
            // The reported Error rides along so the console bridge recognises
            // it and files no second, context-free "Failure in application"
            // issue (MIKE-BACKEND-G mirrored MIKE-BACKEND-F 1:1).
            console.error(
                spent
                    ? "[dbq] job permanently failed"
                    : "[dbq] job failed; will retry",
                { ...summary, error: reportable },
            );
        }
    }
}

/**
 * Claim up to `limit` runnable jobs; a failed claim is gated and yields none.
 * Claiming spans tenants, so `db` here is the platform client in production.
 */
async function claimDbJobs(
    db: Db,
    limit: number,
    claimGate: PollFailureGate,
): Promise<DbJob[]> {
    const tenantCap = tenantConcurrencyCap();
    const { data, error } = await db.rpc("claim_db_jobs", {
        p_limit: limit,
        p_stale_seconds: STALE_SECONDS,
        ...(tenantCap ? { p_tenant_cap: tenantCap } : {}),
    });
    if (error) {
        // Table/function missing (migration not applied yet) or transient DB
        // trouble: log and try again later — never crash the server.
        //
        // asReportableError keeps the PostgREST object as the cause, so its
        // `code` (PGRST202 = RPC missing) reaches failure_code and the issue
        // title says why; re-wrapping `error.message` in a new Error lost it.
        const failure = asReportableError(error, claimDbJobs);
        if (claimGate.failure(failure).report) {
            reportError(failure, {
                tags: { component: "dbq", stage: "claim" },
                fingerprint: ["dbq-claim-failed"],
            });
            // The Error object, not a string: the console bridge dedupes a
            // reported object, a message string it files as a new event.
            console.error("[dbq] claim failed", failure);
        }
        return [];
    }
    claimGate.success();
    return (data ?? []) as DbJob[];
}

export type DbJobPool = {
    /** Claim jobs for every free slot (no-op while a claim is in flight). */
    fill(): Promise<void>;
    /** Jobs currently executing. */
    readonly running: number;
    /** Stop refilling and wait for the claim and every running job. */
    drain(): Promise<void>;
};

/**
 * A fixed number of job slots. The old loop claimed a batch and awaited the
 * whole batch before the next claim, so one three-minute extraction held
 * four idle slots hostage and throughput collapsed to `CLAIM_BATCH` jobs per
 * slowest job. Here each finished job frees its slot and immediately asks
 * for more work, so a slow job only ever occupies its own slot. Concurrency
 * is still capped at `capacity` per process, as before.
 */
export function createDbJobPool(
    db: Db,
    handlers: DbJobHandlers,
    failureHooks: Readonly<Record<string, DbJobFailureHook>> = {},
    opts: { capacity?: number; claimGate?: PollFailureGate; claimDb?: Db } = {},
): DbJobPool {
    const capacity = opts.capacity ?? CLAIM_BATCH;
    const claimGate = opts.claimGate ?? defaultClaimGate;
    // Claiming spans tenants (platform client); each job runs on `db`.
    const claimDb = opts.claimDb ?? db;
    const running = new Set<Promise<void>>();
    let claiming: Promise<void> | null = null;
    let stopped = false;

    const fill = (): Promise<void> => {
        if (claiming) return claiming;
        const free = capacity - running.size;
        if (stopped || free <= 0 || !claimGate.ready()) return Promise.resolve();
        claiming = (async () => {
            let jobs: DbJob[];
            try {
                jobs = await claimDbJobs(claimDb, free, claimGate);
            } catch (err) {
                // fill() is also called fire-and-forget from a finishing
                // job, so it must never reject.
                reportError(err, { tags: { component: "dbq", stage: "tick" } });
                console.error("[dbq] tick failed", err);
                return;
            }
            for (const job of jobs) {
                // processClaimedJob contains its own failures; the catch is
                // defence so one unexpected rejection cannot leak a slot.
                const run: Promise<void> = processClaimedJob(db, handlers, job, failureHooks, claimDb)
                    .catch((err) => {
                        console.error("[dbq] job transition failed", {
                            id: job.id,
                            reason: err instanceof Error ? err.message : "unknown",
                        });
                    })
                    .finally(() => {
                        running.delete(run);
                        void fill();
                    });
                running.add(run);
            }
        })().finally(() => {
            claiming = null;
        });
        return claiming;
    };

    return {
        fill,
        get running() {
            return running.size;
        },
        async drain() {
            stopped = true;
            if (claiming) await claiming;
            await Promise.allSettled([...running]);
        },
    };
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
    //    Drain the backlog in keyset batches: one capped batch per hourly
    //    sweep fell behind for good once more than 2,400 exports finished
    //    in a day. Rows kept after a failed file delete sort before the
    //    cursor, so a retrying row can never pin the loop.
    let after: string | null = null;
    for (let batch = 0; batch < EXPORT_EXPIRY_MAX_BATCHES; batch++) {
        let query = db
            .from("db_jobs")
            .select("id, result, tenant_id")
            .eq("kind", "export.build")
            .eq("status", "done")
            .lt("finished_at", exportCutoff)
            .order("id", { ascending: true })
            .limit(EXPORT_EXPIRY_BATCH);
        if (after) query = query.gt("id", after);
        const { data: expired } = await query;
        const rows = (expired ?? []) as Pick<DbJob, "id" | "result" | "tenant_id">[];
        // Objects are removed a few at a time rather than one after another,
        // and the rows whose object is gone are deleted together.
        const removable = await mapWithConcurrency(rows, STORAGE_DELETE_CONCURRENCY, async (row) => {
            const path = row.result?.storage_path;
            if (typeof path === "string" && path.length > 0) {
                try {
                    // The sweep runs on the platform client with no tenant; the
                    // storage facade resolves the key prefix and location from
                    // the current tenant, so the delete must run as the row's.
                    await runWithJobTenant(row.tenant_id, () => deleteStoredFile(path));
                } catch (err) {
                    // Keep the row so the next sweep retries the file delete.
                    console.error("[dbq] export artifact delete failed", {
                        id: row.id,
                        err,
                    });
                    return null;
                }
            }
            return row.id;
        });
        try {
            await mutateInBatches(
                "export row expiry",
                removable.filter((id): id is string => id !== null),
                (ids) => db.from("db_jobs").delete().in("id", ids),
            );
        } catch (err) {
            // As before, a failed row delete leaves the row for the next sweep.
            console.error("[dbq] export row delete failed", { err });
        }
        if (rows.length < EXPORT_EXPIRY_BATCH) break;
        after = rows[rows.length - 1].id;
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
        .neq("kind", "tenant.purge")
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
let pool: DbJobPool | null = null;

export function dbJobsEnabled(): boolean {
    return process.env.DB_JOBS_ENABLED !== "false";
}

/**
 * Start the poll loop (idempotent). Each interval tops up the job pool's
 * free slots; claims never overlap, and a finished job refills its own slot
 * without waiting for the interval.
 */
export function startDbJobRunner(handlers: DbJobHandlers, failureHooks: Readonly<Record<string, DbJobFailureHook>> = {}): void {
    if (!dbJobsEnabled()) {
        console.log("[dbq] disabled via DB_JOBS_ENABLED=false");
        return;
    }
    if (pollTimer) return;
    const db = createServerSupabase();
    // Claiming and retention span tenants by design (multi-tenant issue 003).
    const platformDb = createPlatformSupabase();

    const jobPool = createDbJobPool(db, handlers, failureHooks, {
        claimDb: platformDb,
    });
    pool = jobPool;
    // While claims keep failing, fill() skips until the backed-off retry
    // time instead of hitting the broken dependency every interval.
    const tick = () => void jobPool.fill();
    pollTimer = setInterval(tick, pollMs());
    pollTimer.unref();
    // First tick shortly after boot so work queued before a restart resumes
    // without waiting a full interval.
    setTimeout(tick, 1_000).unref();

    const sweep = () =>
        void runDbJobRetentionSweep(platformDb).catch((err) => {
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

/** Stop polling and wait for the in-flight jobs to finish (shutdown path). */
export async function stopDbJobRunner(): Promise<void> {
    if (pollTimer) clearInterval(pollTimer);
    if (sweepTimer) clearInterval(sweepTimer);
    pollTimer = null;
    sweepTimer = null;
    const draining = pool;
    pool = null;
    if (draining) await draining.drain();
}

/**
 * Each canonical claimed job keeps its own diagnostic operation/stage scope,
 * and runs as the job's tenant (multi-tenant issue 003; see runClaimedJob).
 */
export async function processClaimedJob(
    db: Db,
    handlers: DbJobHandlers,
    job: DbJob,
    failureHooks: Readonly<Record<string, DbJobFailureHook>> = {},
    controlDb: Db = db,
): Promise<void> {
    const actor = job.kind === "memory.consolidate" ? job.payload?.actorUserId : job.payload?.userId;
    const actorUserId = typeof actor === "string" ? actor : undefined;
    return runIsolated(() =>
        runWithJobTenant(job.tenant_id, () =>
            withLogContext({ jobId: job.id }, () => runClaimedJob(db, handlers, job, failureHooks, controlDb)),
            actorUserId));
}
