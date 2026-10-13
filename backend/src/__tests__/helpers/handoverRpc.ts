// The database's member hand-over functions (org_member_sole_owned_items,
// org_member_private_standalone, assign_org_member_items), for tests whose
// Supabase stand-in is a map of tables.
//
// When a member leaves an organization, the private projects and workflows
// they alone own are handed to a named successor, and their standalone chats
// and reviews that nobody else owns, and their own documents there, are
// deleted. The backend asks the
// database which those are, so a fake has to answer the same way.

type Row = Record<string, unknown>;
type Tables = Record<string, Row[] | undefined>;

const OWNED = {
    project: {
        table: "projects",
        overrides: "project_org_access_overrides",
        key: "project_id",
        title: "name",
    },
    workflow: {
        table: "workflows",
        overrides: "workflow_org_access_overrides",
        key: "workflow_id",
        title: "title",
    },
} as const;

const STANDALONE = {
    chat: { table: "chats", grants: "chat_access_grants", key: "chat_id" },
    tabular_review: {
        table: "tabular_reviews",
        grants: "tabular_review_access_grants",
        key: "tabular_review_id",
    },
} as const;

const isMember = (tables: Tables, orgId: unknown, userId: unknown) =>
    (tables.org_members ?? []).some(
        (member) => member.org_id === orgId && member.user_id === userId,
    );

function soleOwnedItems(tables: Tables, orgId: unknown, userId: unknown) {
    return (Object.keys(OWNED) as (keyof typeof OWNED)[]).flatMap((kind) => {
        const config = OWNED[kind];
        const overrides = tables[config.overrides] ?? [];
        const ownerOverride = (item: Row, of: (holder: unknown) => boolean) =>
            overrides.some(
                (override) =>
                    override[config.key] === item.id &&
                    override.role === "owner" &&
                    of(override.user_id),
            );
        return (tables[config.table] ?? [])
            .filter(
                (item) =>
                    item.org_id === orgId &&
                    item.visibility !== "organization" &&
                    (item.user_id === userId ||
                        ownerOverride(item, (holder) => holder === userId)) &&
                    !(
                        item.user_id !== userId &&
                        isMember(tables, orgId, item.user_id)
                    ) &&
                    !ownerOverride(item, (holder) => holder !== userId),
            )
            .map((item) => ({
                kind,
                item_id: item.id,
                title: item[config.title] ?? null,
            }));
    });
}

function privateStandalone(tables: Tables, orgId: unknown, userId: unknown) {
    const userIdByEmail = new Map(
        (tables.user_profiles ?? []).map((profile) => [
            String(profile.email ?? "").toLowerCase(),
            profile.user_id,
        ]),
    );
    return (Object.keys(STANDALONE) as (keyof typeof STANDALONE)[]).flatMap(
        (kind) => {
            const config = STANDALONE[kind];
            const ownedByAnotherMember = (item: Row) =>
                (tables[config.grants] ?? []).some((grant) => {
                    if (grant[config.key] !== item.id || grant.role !== "owner")
                        return false;
                    const holder = userIdByEmail.get(String(grant.email));
                    return (
                        holder !== undefined &&
                        holder !== userId &&
                        isMember(tables, orgId, holder)
                    );
                });
            return (tables[config.table] ?? [])
                .filter(
                    (item) =>
                        item.org_id === orgId &&
                        !item.project_id &&
                        item.user_id === userId &&
                        !ownedByAnotherMember(item),
                )
                .map((item) => ({ kind, item_id: item.id }));
        },
    );
}

/** Their own documents in the organization: in no project and no workflow. */
function ownStandaloneDocuments(tables: Tables, orgId: unknown, userId: unknown) {
    return (tables.documents ?? [])
        .filter(
            (document) =>
                document.org_id === orgId &&
                !document.project_id &&
                !document.workflow_id &&
                document.user_id === userId,
        )
        .map((document) => ({ kind: "document", item_id: document.id }));
}

/**
 * The answer to one of the hand-over RPCs, or `undefined` for any other
 * function so the caller's own `rpc` stub can handle it.
 */
export function handoverRpcResult(
    tables: Tables,
    name: string,
    args: Record<string, unknown> | undefined,
):
    | { data: unknown; error: null }
    | { data: null; error: { code: string; message: string } }
    | undefined {
    const orgId = args?.p_org_id;
    if (name === "org_member_sole_owned_items")
        return { data: soleOwnedItems(tables, orgId, args?.p_user_id), error: null };
    if (name === "org_member_private_standalone")
        return {
            data: [
                ...privateStandalone(tables, orgId, args?.p_user_id),
                ...ownStandaloneDocuments(tables, orgId, args?.p_user_id),
            ],
            error: null,
        };
    if (name === "assign_org_member_items") {
        const from = args?.p_from_user_id;
        const to = args?.p_to_user_id;
        if (!to || to === from || !isMember(tables, orgId, to))
            return {
                data: null,
                error: {
                    code: "23514",
                    message:
                        "Work is handed to another member of the organization",
                },
            };
        const items = soleOwnedItems(tables, orgId, from);
        for (const item of items) {
            const config = OWNED[item.kind];
            const overrides = (tables[config.overrides] ??= []);
            const existing = overrides.find(
                (override) =>
                    override[config.key] === item.item_id &&
                    override.user_id === to,
            );
            if (existing) existing.role = "owner";
            else
                overrides.push({
                    [config.key]: item.item_id,
                    org_id: orgId,
                    user_id: to,
                    role: "owner",
                    assigned_by: args?.p_assigned_by ?? null,
                });
        }
        return { data: items.length, error: null };
    }
    return undefined;
}
