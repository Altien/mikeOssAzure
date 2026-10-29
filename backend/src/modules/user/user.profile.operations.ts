// user profile operations — implementation behind the module facade.
import { getUserApiKeyStatus } from "./user.apiKeyStore";
import { authProvider } from "../auth/auth.service";
import { supabaseSessionConfiguration } from "../../lib/runtimeConfig";
import { findProfileUserByEmail } from "../../lib/userLookup";
import { replaceUserRouterModels, ROUTER_SLUGS, type RouterSlug } from "../../lib/routerModels";
import { type Db } from "./user.shared";
import { ensureProfileRow, loadProfile } from "./user.profile.load";
import { AppError, type ErrorKind } from "../../lib/appError";

import { PersonalisationUpdate } from "./user.profile.validation";

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export async function bootstrapUserProfile(
    db: Db,
    userId: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    const error = await ensureProfileRow(db, userId);
    if (error) return { ok: false, error };
    return { ok: true };
}

export async function getUserProfile(
    db: Db,
    userId: string,
): Promise<
    { ok: true; body: Record<string, unknown> } | { ok: false; error: unknown }
> {
    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    const { data, error } = await loadProfile(db, userId, {
        repairMissing: true,
        apiKeyStatus,
    });
    if (error) return { ok: false, error };
    return { ok: true, body: { ...data, apiKeyStatus } };
}

/** Returns the minimal identity needed to offer a new direct share. */
export async function lookupUserByEmail(
    db: Db,
    email: string,
): Promise<{
    exists: boolean;
    email: string;
    display_name: string | null;
}> {
    const user = await findProfileUserByEmail(db, email);
    return {
        exists: !!user,
        email: user?.email ?? email.trim().toLowerCase(),
        display_name: user?.display_name ?? null,
    };
}

export async function updateUserProfile(
    db: Db,
    userId: string,
    update: Record<string, unknown>,
    routerModels?: Partial<Record<RouterSlug, string[]>>,
): Promise<
    { ok: true; body: Record<string, unknown> } | { ok: false; error: unknown }
> {
    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError) return { ok: false, error: ensureError };

    const { error: updateError } = await db
        .from("user_profiles")
        .update(update)
        .eq("user_id", userId);
    if (updateError) return { ok: false, error: updateError };

    for (const slug of ROUTER_SLUGS) {
        const models = routerModels?.[slug];
        if (models === undefined) continue;
        try {
            await replaceUserRouterModels(userId, slug, models, db);
        } catch (routerModelsError) {
            return { ok: false, error: routerModelsError };
        }
    }

    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    const { data, error } = await loadProfile(db, userId, { apiKeyStatus });
    if (error) return { ok: false, error };
    return { ok: true, body: { ...data, apiKeyStatus } };
}

// ---------------------------------------------------------------------------
// Onboarding + password capability
// ---------------------------------------------------------------------------

// A failed query as the route's sendInternalError should report it: the kind
// names what broke, the PostgREST object stays the cause so its code still
// extracts; `detail` keeps the message for callers that read it.
function profileWriteFailure(
    kind: ErrorKind,
    message: string,
    cause: { message: string },
): { ok: false; detail: string; error: AppError } {
    return {
        ok: false,
        detail: cause.message,
        error: new AppError(kind, message, { cause }),
    };
}

// Records the personalisation answers and marks onboarding complete.
export async function completeUserOnboarding(
    db: Db,
    userId: string,
    update: PersonalisationUpdate,
): Promise<
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; detail: string; error: AppError }
> {
    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError)
        return profileWriteFailure("db.query_failed", "profile row could not be ensured", ensureError);

    const { error: updateError } = await db
        .from("user_profiles")
        .update({
            ...update,
            onboarding_version: 1,
            updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
    if (updateError)
        return profileWriteFailure("db.query_failed", "onboarding update failed", updateError);

    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    const { data, error } = await loadProfile(db, userId, { apiKeyStatus });
    if (error) return profileWriteFailure("db.query_failed", "profile load failed", error);
    return { ok: true, body: { ...data, apiKeyStatus } };
}

export type RecordPasswordSetResult =
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; kind: "db_error"; detail: string; error: AppError }
    | { ok: false; kind: "provider_error"; status: number; detail: string };

// The normal current-user provider update enforces secure password changes
// and reauthentication. The private Dev database has no auth.users schema.
export async function recordPasswordSet(
    db: Db,
    userId: string,
    accessToken: string,
    password: string,
    nonce?: string,
): Promise<RecordPasswordSetResult> {
    if ((await authProvider()) !== "supabase")
        return { ok: false, kind: "provider_error", status: 403,
            detail: "Password management is owned by your sign-in provider." };
    const { url, key } = supabaseSessionConfiguration();
    if (!url || !key || !accessToken)
        return { ok: false, kind: "provider_error", status: 503,
            detail: "Password management is unavailable." };
    let providerResponse: Response;
    try {
        providerResponse = await fetch(new URL("auth/v1/user", `${url.replace(/\/$/, "")}/`), {
            method: "PUT",
            headers: { apikey: key, Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json" },
            body: JSON.stringify(nonce === undefined ? { password } : { password, nonce }),
        });
    } catch {
        return { ok: false, kind: "provider_error", status: 502,
            detail: "The sign-in provider could not update the password." };
    }
    if (!providerResponse.ok)
        return { ok: false, kind: "provider_error",
            status: providerResponse.status >= 400 && providerResponse.status < 500 ? providerResponse.status : 502,
            detail: providerResponse.status === 403 || providerResponse.status === 422
                ? "The sign-in provider requires a valid reauthentication code or rejected this password."
                : "The sign-in provider could not update the password." };
    const providerUser = await providerResponse.json().catch(() => null) as { id?: unknown } | null;
    if (providerUser?.id !== userId)
        return { ok: false, kind: "provider_error", status: 502,
            detail: "The sign-in provider could not update the password." };
    const ensureError = await ensureProfileRow(db, userId);
    if (ensureError)
        return { kind: "db_error", ...profileWriteFailure("db.query_failed", "Profile row could not be ensured", ensureError) };
    const { error: markerError } = await db.from("user_profiles")
        .update({ password_set_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("user_id", userId);
    if (markerError) return { kind: "db_error", ...profileWriteFailure("db.query_failed", "Password marker could not be recorded", markerError) };

    const apiKeyStatus = await getUserApiKeyStatus(userId, db);
    const { data, error } = await loadProfile(db, userId, { apiKeyStatus });
    if (error)
        return {
            kind: "db_error",
            ...profileWriteFailure("db.query_failed", "profile load failed", error),
        };
    return { ok: true, body: { ...data, apiKeyStatus } };
}
