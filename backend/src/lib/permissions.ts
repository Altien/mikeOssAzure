/**
 * Project-scoped roles and the capability matrix.
 *
 * Every access decision reduces to: derive the caller's ProjectRole for the
 * container (lib/access.ts), then ask `can(role, capability)` here. Routes
 * never compare roles or re-derive rights from an ownership flag — they
 * declare the capability they need, so the policy lives in exactly one table.
 *
 * The ladder (each tier includes everything below it):
 *
 *   role     | granted to
 *   ---------|------------------------------------------------------------
 *   viewer   | read-only access
 *   editor   | content collaboration and organization
 *   owner    | access management and container deletion. Creators are owners.
 *
 *   capability     | min role | covers
 *   ---------------|----------|----------------------------------------------
 *   project.view   | viewer   | read docs/chats/reviews, download, watch
 *                  |          | generation streams
 *   content.edit   | editor   | upload documents, push versions, chat,
 *                  |          | accept/reject edits, run extractions, reshape
 *                  |          | a review's columns/document set
 *   docs.organize  | editor   | rename/move documents AND create/rename/move/
 *                  |          | delete folders
 *   access.manage  | owner    | project settings, sharing and access grants
 *   container.delete | owner  | delete the project/review itself
 *
 * Editors can organize the same content they can modify. Owners additionally
 * control access and may delete the container.
 */

export type ProjectRole = "owner" | "editor" | "viewer";

/** `deny` is an organization-only override, not a capability-bearing role. */
export type OrganizationAccessOverride = ProjectRole | "deny";

/** The role values a direct access grant may carry (the whole ladder). */
export const PROJECT_ROLES: ProjectRole[] = ["owner", "editor", "viewer"];

export function isProjectRole(value: unknown): value is ProjectRole {
    return (
        typeof value === "string" &&
        (PROJECT_ROLES as string[]).includes(value)
    );
}

export type Capability =
    | "project.view"
    | "content.edit"
    | "docs.organize"
    | "access.manage"
    | "container.delete";

const ROLE_RANK: Record<ProjectRole, number> = {
    viewer: 0,
    editor: 1,
    owner: 2,
};

const REQUIRED_RANK: Record<Capability, number> = {
    "project.view": ROLE_RANK.viewer,
    "content.edit": ROLE_RANK.editor,
    "docs.organize": ROLE_RANK.editor,
    "access.manage": ROLE_RANK.owner,
    "container.delete": ROLE_RANK.owner,
};

/**
 * The stronger of two roles; retained for direct-scope compatibility helpers.
 * Organization access is resolved exclusively and never merged with grants.
 */
export function strongerRole(
    a: ProjectRole | null,
    b: ProjectRole | null,
): ProjectRole | null {
    if (!a) return b;
    if (!b) return a;
    return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

/** Fail closed: an absent/unknown role can do nothing. */
export function can(
    role: ProjectRole | null | undefined,
    capability: Capability,
): boolean {
    if (!isProjectRole(role)) return false;
    return ROLE_RANK[role] >= REQUIRED_RANK[capability];
}
