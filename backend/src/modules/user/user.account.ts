// Account / data deletion (destructive â€” exact call args + ordering preserved).
//
// Service layer behind user.routes.ts â€” see user.shared.ts for the module's
// contract. The userDataCleanup helpers + auth-admin deleteUser call are
// invoked with identical args and ordering.

import { deleteUserPrivateMemories } from "../../lib/memory/bulk";
import { dbJobsEnabled } from "../../lib/dbq/runner";
import {
    deleteAllUserChats,
    deleteAllUserTabularReviews,
    deleteUserProjects,
    listOrgsBlockingAccountDeletion,
    type AccountDeletionOrgBlocker,
} from "./user.dataCleanup";
import { type Db, errorMessage } from "./user.shared";

/**
 * Turn the sole-admin blockers into instructions the user can actually act
 * on. The two reasons need DIFFERENT actions â€” appointing a successor fixes
 * an org that still has members, and does nothing for an org whose only
 * problem is that it still owns matters â€” so a single "make another member
 * an admin" sentence sent the second group off to look for members who do
 * not exist. A mixed batch gets both sentences, each naming its own orgs.
 */
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
            `You are the only admin of ${withMembers}. Make another member an admin, or delete the organization, before deleting your account.`,
        );
    const withContent = named("content");
    if (withContent)
        sentences.push(
            `You are the only admin of ${withContent}, which still owns content. Delete or move the organization's projects, workflows, documents and reviews, or delete the organization, before deleting your account.`,
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
        if (error || !data) throw error ?? new Error("Erasure was not scheduled");
        return { ok: true };
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/account] delete failed", {
            userId,
            error: detail,
        });
        return { ok: false, error: err };
    }
}

export async function deleteUserChats(
    db: Db,
    userId: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
        await deleteAllUserChats(db, userId);
        return { ok: true };
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/chats] delete failed", {
            userId,
            error: detail,
        });
        return { ok: false, error: err };
    }
}

export async function deleteUserProjectsData(
    db: Db,
    userId: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
        await deleteUserProjects(db, userId);
        return { ok: true };
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/projects] delete failed", {
            userId,
            error: detail,
        });
        return { ok: false, error: err };
    }
}

export async function deleteUserTabularReviews(
    db: Db,
    userId: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
        await deleteAllUserTabularReviews(db, userId);
        return { ok: true };
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/tabular-reviews] delete failed", {
            userId,
            error: detail,
        });
        return { ok: false, error: err };
    }
}

/**
 * Wipe the user's app memory and the memories of private projects they
 * created. Organization and merely shared projects are intentionally outside
 * this account-level destructive action.
 */
export async function deletePrivateMemories(
    db: Db,
    userId: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
        await deleteUserPrivateMemories(db, userId);
        return { ok: true };
    } catch (err) {
        console.error("[user/memories] delete failed", {
            userId,
            error: errorMessage(err),
        });
        return { ok: false, error: err };
    }
}
