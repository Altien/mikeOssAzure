import type { Db } from "../../lib/supabase";
import type { DbJob } from "../../lib/dbq/types";

export type PlaybookJobIdentity = { id: string; attempt: number; token: string };
export function playbookJobIdentity(job: DbJob): PlaybookJobIdentity {
  if (!job.claim_token) throw new Error("Playbook job has no canonical claim token");
  return { id: job.id, attempt: job.attempts, token: job.claim_token };
}
export class PlaybookClaimLostError extends Error {
  constructor() { super("Playbook job ownership changed"); this.name="PlaybookClaimLostError"; }
}
export async function mutatePlaybookJob(db: Db, identity: PlaybookJobIdentity,
  operation: "check" | "heartbeat" | "import_progress" | "import_publish" | "review_publish" | "failure",
  domainId: string, values: Record<string, unknown> = {}, terminal = false,
): Promise<Record<string, unknown>> {
  const { data, error } = await db.rpc("mutate_playbook_job", {
    p_job_id: identity.id, p_attempt: identity.attempt, p_token: identity.token,
    p_operation: operation, p_domain_id: domainId, p_values: values, p_terminal: terminal,
  });
  if (error) { if (error.code === "40001") throw new PlaybookClaimLostError(); throw error; }
  if (!data || data.result === "stale") throw new PlaybookClaimLostError();
  if (data.result === "conflict") throw Object.assign(new Error("The playbook changed. Import it again."), { code: "PLAYBOOK_REPLACEMENT_CONFLICT" });
  if (data.result === "forbidden") throw Object.assign(new Error("Playbook access changed. Run the operation again."), { code: "PLAYBOOK_ACCESS_CHANGED" });
  return data as Record<string, unknown>;
}
