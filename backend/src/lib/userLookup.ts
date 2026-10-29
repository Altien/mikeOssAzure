import { createServerSupabase, type Db } from "./supabase";
import { chunkArray } from "./arrays";
import { safeError } from "./safeError";

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
 */
export async function loadProfileUsersByEmail(
    db: Db,
    people: { userIds: string[]; emails: string[] },
) {
    const data: { user_id: string; email: string | null; display_name: string | null; profile_photo?: string | null }[] = [];
    for (const [column, values] of [
        ["user_id", people.userIds],
        ["email", people.emails.map(normalizeEmail).filter(Boolean)],
    ] as const) {
        for (const batch of chunkArray([...new Set(values)], 50)) {
            const result = await db.from("user_profiles")
                .select("user_id, email, display_name, profile_photo").in(column, batch);
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
    const userIds = [
        ...new Set(
            rows
                .map((row) => row.user_id)
                .filter((id): id is string => typeof id === "string" && id.length > 0),
        ),
    ];
    if (userIds.length === 0) return byUserId;
    const { data, error } = await db
        .from("user_profiles")
        .select("user_id, display_name, email, profile_photo")
        .in("user_id", userIds);
    if (error) {
        console.warn("[userLookup] failed to load creator profiles", safeError(error));
        return byUserId;
    }
    for (const row of data ?? []) {
        byUserId.set(row.user_id as string, {
            display_name: normalizeDisplayName(row.display_name),
            email: normalizeEmail(row.email) || null,
            profile_photo: (row as { profile_photo?: string | null }).profile_photo ?? null,
        });
    }
    return byUserId;
}

/** Finds public sharing identity fields without exposing an unscoped photo. */
export async function findProfileUserByEmail(db: Db, email: string) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;

    const { data, error } = await db
        .from("user_profiles")
        .select("user_id, email, display_name")
        .eq("email", normalized)
        .maybeSingle();
    if (error) throw error;
    if (!data) return null;

    return {
        id: data.user_id as string,
        email: normalized,
        display_name: normalizeDisplayName(data.display_name),
    };
}

export async function findMissingUserEmails(db: Db, emails: string[]) {
    const normalizedEmails = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
    if (normalizedEmails.length === 0) return [];

    const { data, error } = await db
        .from("user_profiles")
        .select("email")
        .in("email", normalizedEmails);
    if (error) throw error;

    const found = new Set(
        (data ?? [])
            .map((row) => normalizeEmail(row.email))
            .filter(Boolean),
    );
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
                    onConflict: "user_id",
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
