// Resolves a user's Entra group memberships, with a Graph fallback for
// the overage case where Entra has dropped the inline `groups` claim
// from the id_token because the user is in too many groups to fit
// (size budget, not strictly the documented 200-count limit — see
// gap #6 in docs/issues/azure-migration/036-marketplace-install-gaps.md).
//
// Decision sequence:
//   1. If `claims.groups` is a non-empty array → return as-is.
//   2. If `claims.hasgroups === "true"` OR `claims._claim_names` is
//      present → overage. Call Microsoft Graph /me/memberOf using
//      the provided access token. Cache per (oid, iat) for 5 minutes.
//   3. Otherwise (no overage indicator, no inline groups) → user is
//      genuinely in no groups for this app reg. Return [].
//
// All failure paths return [] (fail-closed). The caller's isInAdminGroup
// then refuses access, which is the safe default.
//
// This is the additive Graph-fallback path. The existing inline-claim
// path stays intact — most users don't hit overage and the inline
// claim is faster (no Graph hop). Per the no-strip-redundant-code
// principle, both paths coexist. See 036a Phase 7 (B4 reinterpreted).

type Claims = Record<string, unknown>;

type CacheEntry = {
    groups: string[];
    fetchedAt: number;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

function isOverage(claims: Claims): boolean {
    // Implicit-flow form (we don't use it for /install, but check anyway
    // — `hasgroups` can appear in either flow depending on token shape).
    if (claims.hasgroups === true || claims.hasgroups === "true") return true;
    // Auth-code-flow form: _claim_names: { groups: "src1" }, with
    // _claim_sources pointing at the Graph endpoint. We don't read the
    // endpoint pointer; just detect the indicator and call Graph
    // ourselves with /me/memberOf for consistency.
    if (typeof claims._claim_names === "object" && claims._claim_names !== null) {
        const names = claims._claim_names as Record<string, unknown>;
        if ("groups" in names) return true;
    }
    return false;
}

function extractInline(claims: Claims): string[] {
    if (!Array.isArray(claims.groups)) return [];
    return (claims.groups as unknown[])
        .filter((g): g is string => typeof g === "string" && g.length > 0);
}

async function fetchFromGraph(accessToken: string): Promise<string[]> {
    // /me/memberOf returns both groups and directory roles, all as
    // directoryObject ids. For admin-group check we only need the
    // GUIDs, not the names — `$select=id` keeps the response small.
    const resp = await fetch(
        "https://graph.microsoft.com/v1.0/me/memberOf?$select=id",
        { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!resp.ok) {
        console.warn("graph.memberOf_failed", { status: resp.status });
        return [];
    }
    const data = (await resp.json()) as { value?: Array<{ id?: string }> };
    return (data.value ?? [])
        .map((g) => (typeof g?.id === "string" ? g.id : ""))
        .filter((id): id is string => id.length > 0);
}

// Best-effort lookup of group display names via Graph, keyed by group
// GUID. Used to enrich the 403 "Not in admin group" page so the
// operator can see WHICH group they need to be in, not just the GUID.
// Cache survives across requests for 5 minutes (group names don't
// usually change). Returns the GUID as fallback if the lookup fails
// or the access token can't see the group.
const nameCache = new Map<string, { name: string; fetchedAt: number }>();

export async function resolveGroupNames(
    groupIds: string[],
    accessToken: string | undefined,
): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (groupIds.length === 0) return result;

    const now = Date.now();
    const toFetch: string[] = [];

    for (const id of groupIds) {
        const cached = nameCache.get(id);
        if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
            result.set(id, cached.name);
        } else {
            toFetch.push(id);
        }
    }

    if (toFetch.length === 0 || !accessToken) {
        // No token, or all from cache: fill any uncached with their GUID
        // so the caller always gets a complete map.
        for (const id of toFetch) result.set(id, id);
        return result;
    }

    await Promise.all(
        toFetch.map(async (id) => {
            try {
                const resp = await fetch(
                    `https://graph.microsoft.com/v1.0/groups/${encodeURIComponent(id)}?$select=displayName`,
                    { headers: { Authorization: `Bearer ${accessToken}` } },
                );
                if (!resp.ok) {
                    result.set(id, id);
                    return;
                }
                const data = (await resp.json()) as { displayName?: string };
                const name = data.displayName || id;
                nameCache.set(id, { name, fetchedAt: now });
                result.set(id, name);
            } catch {
                result.set(id, id);
            }
        }),
    );
    return result;
}

export async function resolveUserGroups(
    claims: Claims | null,
    accessToken: string | undefined,
): Promise<string[]> {
    if (!claims) return [];

    const inline = extractInline(claims);
    if (inline.length > 0) return inline;

    if (!isOverage(claims)) return [];
    if (!accessToken) return [];

    const oid = typeof claims.oid === "string" ? claims.oid : "";
    const iat = typeof claims.iat === "number" ? claims.iat : 0;
    // Only cache when we have a real per-user key. Falling back to ":0"
    // would cause different users to share cache entries during the same
    // window — correctness bug. Without a key we just fetch every time.
    const cacheable = oid !== "" && iat !== 0;
    const cacheKey = cacheable ? `${oid}:${iat}` : "";

    const now = Date.now();
    if (cacheable) {
        const cached = cache.get(cacheKey);
        if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
            return cached.groups;
        }
    }

    try {
        const groups = await fetchFromGraph(accessToken);
        if (cacheable) {
            cache.set(cacheKey, { groups, fetchedAt: now });
        }
        return groups;
    } catch (err) {
        console.warn("graph.memberOf_error", {
            error: err instanceof Error ? err.message : String(err),
        });
        return [];
    }
}
