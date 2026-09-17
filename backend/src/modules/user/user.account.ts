// Account / data deletion (destructive — exact call args + ordering preserved).
//
// Service layer behind user.routes.ts — see user.shared.ts for the module's
// contract. The userDataCleanup helpers + auth-admin deleteUser call are
// invoked with identical args and ordering.

import { deleteUserPrivateMemories } from "../../lib/memory/bulk";
import { dbJobsEnabled } from "../../lib/dbq/runner";
import {
    deleteAllUserChats,
    deleteAllUserTabularReviews,
    deleteUserProjects,
} from "./user.dataCleanup";
import { type Db, errorMessage } from "./user.shared";

export async function deleteUserAccount(
    db: Db,
    userId: string,
    userEmail: string | undefined,
    _token: string | undefined,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
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
