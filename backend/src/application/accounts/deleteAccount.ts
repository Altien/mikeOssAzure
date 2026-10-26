// Account / data deletion (destructive â€” exact call args + ordering preserved).
//
// Application service invoked by the user HTTP entrypoint. The userDataCleanup helpers + auth-admin deleteUser call are
// invoked with identical args and ordering.
import { dbJobsEnabled } from "../../lib/dbq/runner";
import {
    listOrgsBlockingAccountDeletion,
    type AccountDeletionOrgBlocker,
} from "./dataCleanup";
import { withKind, type ErrorKind } from "../../lib/appError";
import { type Db } from "../../lib/serviceData";

/**
 * The failure as the route's sendInternalError should report it: its kind
 * names the flow that broke, the thrown value (an Error or a PostgREST
 * object) stays the cause so its code still extracts. Nothing is logged
 * here — the route logs the same object once, with the request id.
 */
function deletionFailure(kind: ErrorKind, message: string, cause: unknown): Error {
    return withKind(cause, kind, message);
}

/** Explain which organizations need an owner before account deletion. */
export function describeAccountDeletionBlockers(
    blockers: AccountDeletionOrgBlocker[],
): string {
    const named = (reason: AccountDeletionOrgBlocker["reason"]) =>
        blockers
            .filter((blocker) => blocker.reason === reason)
            .map((blocker) => blocker.name)
            .join(", ");
    const sentences: string[] = [];
    const withMembers = named("members");
    if (withMembers)
        sentences.push(
            `You are the only owner of ${withMembers}. Make another member an owner, or delete the organization, before deleting your account.`,
        );
    const withContent = named("content");
    if (withContent)
        sentences.push(
            `You are the only owner of ${withContent}, and must appoint another owner or explicitly delete the organization before deleting your account.`,
        );
    return sentences.join(" ");
}
export async function deleteUserAccount(
    db: Db,
    userId: string,
    userEmail: string | undefined,
    _token: string | undefined,
): Promise<
    | { ok: true }
    | { ok: false; kind: "org_successor_required"; blockers: AccountDeletionOrgBlocker[] }
    | { ok: false; error: unknown; kind?: undefined }
> {
    try {
        // ORGANIZATIONS FIRST. An account that is the only owner of an
        // team organization cannot be deleted, even when it is empty:
        // promoting an arbitrary successor hands a firm's matters to whoever
        // joined first (and silently clears their `deny` overrides), while
        // removing the member outright is refused by the last-owner guard
        // (org_members_protect_last_owner), and would otherwise leave the
        // organization memberless, invisible and undeletable. Answer 409 and let the user
        // choose a successor. This check runs BEFORE the enqueue so nothing
        // is scheduled, revoked, or destroyed.
        const blockers = await listOrgsBlockingAccountDeletion(db, userId);
        if (blockers.length > 0)
            return { ok: false, kind: "org_successor_required", blockers };
        // One database transaction tombstones the identity, revokes app
        // sessions, and queues the durable erasure job. Provider identities
        // are only removed by the worker when the provider owns one.
        if (!dbJobsEnabled()) throw new Error("Account erasure worker is unavailable");
        const provider = (process.env.AUTH_PROVIDER ?? "supabase").toLowerCase();
        const { data, error } = await db.rpc("request_account_erasure", {
            p_user_id: userId,
            p_user_email: userEmail?.toLowerCase() ?? null,
            p_provider: provider,
        });
        if (error?.code === "23514") {
            const currentBlockers = await listOrgsBlockingAccountDeletion(db, userId);
            if (currentBlockers.length) return { ok: false, kind: "org_successor_required", blockers: currentBlockers };
        }
        if (error || !data) throw error ?? new Error("Erasure was not scheduled");
        return { ok: true };
    } catch (err) {
        return {
            ok: false,
            error: deletionFailure("account.delete_failed", "account deletion failed", err),
        };
    }
}
