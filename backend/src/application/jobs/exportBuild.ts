// Queue transport adapter; authorization and artifact creation belong to the workflow.
import type { Db, DbJob, DbJobHandler } from "../../lib/dbq/types";
import { buildExport, discardUnpublishedExportResult } from "../exports/buildExport";

// Dev (sync-log: 877f4598): the claim (attempts + claim_token) travels with
// the request so each attempt is fenced, and the unpublished-result hook
// removes an attempt's artifact that never became the published pointer.
function buildClaimedExport(db: Db, job: DbJob): Promise<Record<string, unknown>> {
    return buildExport(db, {
        id: job.id,
        payload: job.payload,
        attempts: job.attempts,
        claim_token: job.claim_token,
    });
}

export const handleExportBuild: DbJobHandler = Object.assign(buildClaimedExport, {
    onUnpublishedResult: discardUnpublishedExportResult,
});
