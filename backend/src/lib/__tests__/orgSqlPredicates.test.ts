import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static checks on the org RPCs' SQL.
//
// The visibility predicates in the consolidated organization-access migration
// are the SQL twins of lib/access.ts,
// and the mistakes below are invisible in review because the wrong version
// and the right version differ by one word. Exercising them
// properly needs a live Postgres (npm run test:stack), which does not run in
// `npm test` — so these read the shipped SQL and assert the shape directly.
// A grep-shaped test is a poor substitute for executing the query, and a very
// good substitute for nothing.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "../../..");
const SOURCES = {
    "migrations/20260904_01_organization_access.sql": readFileSync(
        resolve(ROOT, "migrations/20260904_01_organization_access.sql"),
        "utf8",
    ),
    "schema.sql": readFileSync(resolve(ROOT, "schema.sql"), "utf8"),
};

describe.each(Object.entries(SOURCES))("%s", (_name, sql) => {
    it("compares p_user_email case-insensitively everywhere", () => {
        // Emails are stored lowercase (all access-grant tables carry a
        // lowercase CHECK), and every predicate lower()s the
        // caller's address before comparing — except two arms that did not,
        // so a caller whose account email is "B@Example.com" was invisible to
        // exactly those two branches while every sibling branch admitted
        // them. List and detail disagreeing about the same review is the bug
        // class this PR exists to close.
        //
        // Rather than enumerate the legitimate uses (declarations,
        // pass-throughs, coalesce guards), this looks only for the two shapes
        // that actually compare a stored value against the raw parameter.
        const offenders = sql
            .split("\n")
            .map((line, index) => [index + 1, line.trim()] as const)
            .filter(
                ([, line]) =>
                    /@>\s*jsonb_build_array\(\s*p_user_email\s*\)/.test(line) ||
                    /(=|<>|like|ilike)\s*p_user_email\b/i.test(line),
            );
        expect(offenders).toEqual([]);
    });

    it("derives workflow capabilities from the effective resource role", () => {
        const orgArms = [
            ...sql.matchAll(/org_shared as \(([\s\S]*?)\n  \),/g),
        ].map(([, body]) => body);
        // Only the arms that project an allow_edit column: the filter-options
        // RPC has an org arm too, and it returns facets, not capabilities.
        const editArms = orgArms.filter((arm) => /as allow_edit/.test(arm));
        expect(editArms.length).toBeGreaterThan(0);
        for (const arm of editArms) {
            expect(arm).toContain("in ('owner', 'editor')) as allow_edit");
            expect(arm).toContain("= 'owner') as is_owner");
        }
    });

    it("never offers NULL as an owner-filter option", () => {
        // `on delete set null` means a project can outlive its creator with
        // user_id = NULL. Emitting that as a dropdown option produced an entry
        // whose value is null — and selecting it made the guard
        // `p_owner_user_id is null or p.user_id::text = p_owner_user_id` true
        // for every row, so the filter silently disabled itself rather than
        // narrowing anything.
        const cte = sql.slice(
            sql.indexOf("distinct_owners as ("),
            sql.indexOf("owner_options as ("),
        );
        expect(cte).toContain("distinct_owners as (");
        expect(cte).toMatch(/where\s+vp\.user_id\s+is\s+not\s+null/);
    });

    it("binds overrides to the resource's current organization", () => {
        for (const join of [
            "o.org_id = p_org_id",
        ]) {
            expect(sql.match(new RegExp(join.replace(".", "\\."), "g"))?.length)
                .toBeGreaterThanOrEqual(2);
        }
        expect(sql).toContain("org_members_cleanup_access_overrides");
        expect(sql).toContain("org_id is distinct from new.org_id");
    });
});

it("the final schema and access-grant migration contain no jsonb share predicate", () => {
    const latest = SOURCES["migrations/20260904_01_organization_access.sql"];
    for (const sql of [SOURCES["schema.sql"], latest]) {
        expect(sql).not.toMatch(/shared_with\s+@>/);
        expect(sql).toContain("tabular_review_access_grants");
        expect(sql).toContain("chat_access_grants");
        expect(sql).toMatch(/g\.email\s*=\s*lower\(p_user_email\)/);
    }
});

it("keeps organization scope exclusive to projects and workflows", () => {
    const schema = SOURCES["schema.sql"];
    const migration = SOURCES["migrations/20260904_01_organization_access.sql"];

    expect(schema).not.toContain("create table if not exists public.chat_org_access_overrides");
    expect(schema).not.toContain(
        "create table if not exists public.tabular_review_org_access_overrides",
    );
    expect(schema).toContain("constraint chats_org_requires_project");
    expect(schema).toContain("constraint tabular_reviews_org_requires_project");
    expect(migration).not.toContain("public.chat_org_access_overrides");
    expect(migration).not.toContain("public.tabular_review_org_access_overrides");
    expect(migration).toContain("chats_org_requires_project");
    expect(migration).toContain("tabular_reviews_org_requires_project");
});

it("makes organization Admin ownership immutable in SQL", () => {
    const migration = SOURCES["migrations/20260904_01_organization_access.sql"];
    for (const sql of [SOURCES["schema.sql"], migration]) {
        const adminBranches = [...sql.matchAll(/when m\.role = 'admin' then 'owner'/g)];
        expect(adminBranches).toHaveLength(2);
        expect(sql).toContain("Organization admins always have owner access");
        expect(sql).toContain("org_members_cleanup_admin_overrides");
    }
});
