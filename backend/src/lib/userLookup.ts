import { createServerSupabase, type Db } from "./supabase";
import { chunkArray } from "./arrays";
import { selectInBatches } from "./batchedQuery";
import { safeError } from "./safeError";
import { currentTenant } from "./tenantContext";
import { getTenancyMode } from "./tenancyMode";

// Multi-tenant 006: an email is unique only within a tenant. Inside a tenant
// scope, lookups by email see that tenant's profiles only (RLS, issue 008,
// enforces the same in the database). Outside a scope there is one tenant.

export type ProfileUserInfo = {
    id: string;
    email: string;
    display_name: string | null;
    profile_photo?: string | null;
};

export function normalizeEmail(value: unknown) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeDisplayName(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function profileAttributionName(
    profile: { display_name?: unknown; email?: unknown } | null | undefined,
    fallback: string,
) {
    return (
        normalizeDisplayName(profile?.display_name) ||
        normalizeEmail(profile?.email) ||
        fallback
    );
}

/**
 * Indexes normalized profile identities by email and user ID.
 * Reads only explicit, caller-authorized roster identities, in bounded batches.
 * Inside a tenant scope only that tenant's profiles are read (multi-tenant 006).
 */
export async function loadProfileUsersByEmail(
    db: Db,
    people: { userIds: string[]; emails: string[] },
) {
    const tenantId = currentTenant()?.tenantId;
    const data: { user_id: string; email: string | null; display_name: string | null; profile_photo?: string | null }[] = [];
    for (const [column, values] of [
        ["user_id", people.userIds],
        ["email", people.emails.map(normalizeEmail).filter(Boolean)],
    ] as const) {
        for (const batch of chunkArray([...new Set(values)], 50)) {
            let query = db.from("user_profiles")
                .select("user_id, email, display_name, profile_photo").in(column, batch);
            if (tenantId) query = query.eq("tenant_id", tenantId);
            const result = await query;
            if (result.error) throw result.error;
            data.push(...(result.data ?? []));
        }
    }

    const userByEmail = new Map<string, ProfileUserInfo>();
    const userById = new Map<string, ProfileUserInfo>();
    for (const row of data ?? []) {
        const email = normalizeEmail(row.email);
        if (!email) continue;
        const info = {
            id: row.user_id as string,
            email,
            display_name: normalizeDisplayName(row.display_name),
            profile_photo: row.profile_photo ?? null,
        };
        userByEmail.set(email, info);
        userById.set(info.id, info);
    }

    return { userByEmail, userById };
}

export type CreatorProfile = {
    display_name: string | null;
    /** Only lists that already expose creator emails may pass this on. */
    email: string | null;
    profile_photo: string | null;
};

/**
 * Loads the name and photo of each creator of rows the caller is already
 * authorized to list, keyed by user ID. A failed lookup only warns: a missing
 * avatar must never fail the listing that wanted it.
 */
export async function loadCreatorProfiles(
    db: Db,
    rows: { user_id?: string | null }[],
): Promise<Map<string, CreatorProfile>> {
    const byUserId = new Map<string, CreatorProfile>();
    let data: { user_id: unknown; display_name: unknown; email: unknown; profile_photo?: string | null }[];
    try {
        data = await selectInBatches(
            "creator profile lookup",
            rows.map((row) => row.user_id),
            (batch) =>
                db
                    .from("user_profiles")
                    .select("user_id, display_name, email, profile_photo")
                    .in("user_id", batch),
        );
    } catch (error) {
        console.warn("[userLookup] failed to load creator profiles", safeError(error));
        return byUserId;
    }
    for (const row of data) {
        byUserId.set(row.user_id as string, {
            display_name: normalizeDisplayName(row.display_name),
            email: normalizeEmail(row.email) || null,
            profile_photo: row.profile_photo ?? null,
        });
    }
    return byUserId;
}

/** Finds public sharing identity fields without exposing an unscoped photo. */
export async function findProfileUserByEmail(db: Db, email: string) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;

    const tenantId = currentTenant()?.tenantId;
    let query = db
        .from("user_profiles")
        .select("user_id, email, display_name")
        .eq("email", normalized);
    if (tenantId) query = query.eq("tenant_id", tenantId);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    if (!data) return null;
    if (!(await isCurrentTenantMember(db, data.user_id))) return null;

    return {
        id: data.user_id as string,
        email: normalized,
        display_name: normalizeDisplayName(data.display_name),
    };
}

// Historical profiles remain after a move. Pooled sharing must resolve a
// current membership, including the enterprise admission mirror, not that
// historical profile. Single-tenant installs retain their profile-based model.
async function isCurrentTenantMember(db: Db, userId: unknown): Promise<boolean> {
    if ((await getTenancyMode()) !== "pooled") return true;
    if (typeof userId !== "string" || !userId.trim()) return false;
    const { data, error } = await db.rpc("tenant_member_exists", { p_user_id: userId });
    if (error) throw error;
    return data === true;
}

export async function findMissingUserEmails(db: Db, emails: string[]) {
    const normalizedEmails = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
    if (normalizedEmails.length === 0) return [];

    const tenantId = currentTenant()?.tenantId;
    let query = db
        .from("user_profiles")
        .select("user_id, email")
        .in("email", normalizedEmails);
    if (tenantId) query = query.eq("tenant_id", tenantId);
    const { data, error } = await query;
    if (error) throw error;

    const eligible = await Promise.all((data ?? []).map(async (row) =>
        await isCurrentTenantMember(db, row.user_id) ? normalizeEmail(row.email) : "",
    ));
    const found = new Set(eligible.filter(Boolean));
    return normalizedEmails.filter((email) => !found.has(email));
}

export async function syncProfileEmail(
    db: Db,
    userId: string,
    email: string | null | undefined,
) {
    const normalizedEmail = normalizeEmail(email);
    if (!userId || !normalizedEmail) return null;

    const { data: existing, error: loadError } = await db
        .from("user_profiles")
        .select("email")
        .eq("user_id", userId)
        .maybeSingle();
    if (loadError) return loadError;

    if (!existing) {
        const { error } = await db.from("user_profiles").insert({
            user_id: userId,
            email: normalizedEmail,
        });
        return error;
    }

    if (normalizeEmail(existing.email) === normalizedEmail) return null;

    const { error } = await db
        .from("user_profiles")
        .update({
            email: normalizedEmail,
            updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
    return error;
}

export async function upsertUserProfile(
    userId: string,
    email?: string | null,
    displayName?: string | null,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<void> {
    const client = db ?? createServerSupabase();
    const lowercaseEmail = email?.trim().toLowerCase() || null;
    const seedDisplayName = displayName?.trim() || null;

    // Two-phase to keep IdP-provided display names from clobbering whatever
    // a user has typed into their Account page:
    //   1. SELECT the existing row (if any) — we need to know whether
    //      display_name is currently null, which is the back-fill condition.
    //   2a. New user → conflict-safe INSERT with email + display_name from the
    //       IdP. Several first-page requests run concurrently, so every caller
    //       can observe the row as missing. Ignore a duplicate user_id here;
    //       the winning request inserted the same authenticated principal.
    //   2b. Returning user → UPDATE email always (IdP is source of truth);
    //       only update display_name when the existing value is null.
    const { data: existing, error: selectError } = await client
        .from("user_profiles")
        .select("email, display_name")
        .eq("user_id", userId)
        .maybeSingle();
    if (selectError) {
        throw new Error(`Failed to read user profile: ${selectError.message}`);
    }

    if (!existing) {
        const { error: insertError } = await client
            .from("user_profiles")
            .upsert(
                {
                    user_id: userId,
                    email: lowercaseEmail,
                    display_name: seedDisplayName,
                },
                {
                    // tenant_id comes from the column default (0176/0177).
                    onConflict: "tenant_id,user_id",
                    ignoreDuplicates: true,
                },
            );
        if (insertError) {
            throw new Error(
                `Failed to create user profile: ${insertError.message}`,
            );
        }
        return;
    }

    const updates: Record<string, string | null> = {};
    if ((existing.email as string | null) !== lowercaseEmail) {
        updates.email = lowercaseEmail;
    }
    if (
        seedDisplayName &&
        ((existing.display_name as string | null) ?? "").trim() === ""
    ) {
        updates.display_name = seedDisplayName;
    }

    if (Object.keys(updates).length === 0) return;

    const { error: updateError } = await client
        .from("user_profiles")
        .update(updates)
        .eq("user_id", userId);
    if (updateError) {
        throw new Error(`Failed to update user profile: ${updateError.message}`);
    }
}
