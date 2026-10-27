import type { Db, DbJob } from "../dbq/types";

export class ExtractionClaimLostError extends Error {
  constructor() { super("document_extraction_claim_lost"); this.name = "AbortError"; }
}
/** Cancellation is advisory; canonical claim/publish/fail RPCs remain atomic authority. */
export async function withClaimCancellation<T>(db: Db, job: DbJob,
  work: (signal: AbortSignal, assertCurrent: () => Promise<void>) => Promise<T>,
): Promise<T> {
  if (!job.claim_token) throw new ExtractionClaimLostError();
  const controller = new AbortController();
  const assertCurrent = async () => {
    controller.signal.throwIfAborted();
    const { data, error } = await db.from("db_jobs")
      .select("status,attempts,claim_token,lease_expires_at").eq("id", job.id).maybeSingle();
    if (error) { controller.abort(error); throw error; }
    if (!data || data.status !== "running" || data.attempts !== job.attempts ||
      data.claim_token !== job.claim_token || !data.lease_expires_at || Date.parse(data.lease_expires_at) <= Date.now()) {
      controller.abort(new ExtractionClaimLostError());
      controller.signal.throwIfAborted();
    }
  };
  let checking = false;
  const timer = setInterval(() => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    void assertCurrent().catch(() => {}).finally(() => { checking = false; });
  }, 10_000);
  timer.unref?.();
  try { await assertCurrent(); return await work(controller.signal, assertCurrent); }
  finally { clearInterval(timer); controller.abort(new ExtractionClaimLostError()); }
}
