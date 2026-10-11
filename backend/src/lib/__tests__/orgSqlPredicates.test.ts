import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
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
// Dev drift: Dev has no schema.sql and ships upstream's
// 20260904_01_organization_access.sql as numbered 0083; the numbered history
// is the schema for fresh and existing databases. Later forward corrections
// (0093, ...) are checked for the email-predicate rule below.
const ORG_ACCESS_MIGRATION = "migrations/0083_organization_access.sql";
const SOURCES = {
    [ORG_ACCESS_MIGRATION]: readFileSync(resolve(ROOT, ORG_ACCESS_MIGRATION), "utf8"),
};
const SCHEMA = SOURCES[ORG_ACCESS_MIGRATION];
const LATER_MIGRATIONS = readdirSync(resolve(ROOT, "migrations"))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && f > "0083_")
    .map((f) => [f, readFileSync(resolve(ROOT, "migrations", f), "utf8")] as const);

it.each(LATER_MIGRATIONS)("%s compares p_user_email case-insensitively", (_name, sql) => {
    const offenders = sql
        .split("\n")
        .filter(
            (line) =>
                /@>\s*jsonb_build_array\(\s*p_user_email\s*\)/.test(line) ||
                /(=|<>|like|ilike)\s*p_user_email\b/i.test(line),
        );
    expect(offenders).toEqual([]);
});

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
    const latest = SOURCES[ORG_ACCESS_MIGRATION];
    for (const sql of [SCHEMA, latest]) {
        expect(sql).not.toMatch(/shared_with\s+@>/);
        expect(sql).toContain("tabular_review_access_grants");
        expect(sql).toContain("chat_access_grants");
        expect(sql).toMatch(/g\.email\s*=\s*lower\(p_user_email\)/);
    }
});

it("keeps organization scope exclusive to projects and workflows", () => {
    const schema = SCHEMA;
    const migration = SOURCES[ORG_ACCESS_MIGRATION];

    expect(schema).not.toContain("create table if not exists public.chat_org_access_overrides");
    expect(schema).not.toContain(
        "create table if not exists public.tabular_review_org_access_overrides",
    );
    // Dev drift: numbered migration adds these via ALTER TABLE ... ADD CONSTRAINT.
    expect(schema).toMatch(/constraint chats_org_requires_project/i);
    expect(schema).toMatch(/constraint tabular_reviews_org_requires_project/i);
    expect(migration).not.toContain("public.chat_org_access_overrides");
    expect(migration).not.toContain("public.tabular_review_org_access_overrides");
    expect(migration).toContain("chats_org_requires_project");
    expect(migration).toContain("tabular_reviews_org_requires_project");
});

// Organization content is private by default. The two role functions are the
// SQL twins of resolveOrgContentRole (lib/access.ts), and every list RPC
// decides visibility through them.
describe("private-by-default organization access in SQL", () => {
    const migration = readFileSync(
        resolve(ROOT, "migrations/0113_org_private_by_default.sql"),
        "utf8",
    );
    const roleFunction = (sql: string, name: string) => {
        const start = sql.indexOf(`create or replace function public.${name}(`);
        expect(start).toBeGreaterThan(-1);
        return sql.slice(start, sql.indexOf("\n$$;\n", start));
    };

    describe.each([
        ["the migration", migration],
    ])("%s", (_name, sql) => {
        it.each(["project_access_role", "workflow_access_role"])(
            "%s resolves creator, owner, override, then public, then nothing",
            (name) => {
                const body = roleFunction(sql, name);
                // The order matters: an override must be read before the
                // public default, or a denial on a public item is ignored.
                const order = [
                    "= p_user_id then 'owner'",
                    "when m.role = 'owner' then 'owner'",
                    "when o.role = 'deny' then null",
                    "when o.role in ('owner', 'editor', 'viewer') then o.role",
                    ") = 'organization' then 'editor'",
                    "else null",
                ].map((fragment) => body.indexOf(fragment));
                expect(order.every((index) => index > -1)).toBe(true);
                expect([...order].sort((x, y) => x - y)).toEqual(order);
                // No implicit standing for admins, and no "everyone is an
                // editor" fallback.
                expect(body).not.toMatch(/m\.role in \('owner', 'admin'\)/);
                expect(body).not.toMatch(/m\.role = 'admin'/);
                expect(body).not.toMatch(/else 'editor'/);
            },
        );

        it("only an organization owner is exempt from overrides", () => {
            expect(sql).toContain("Organization owners always have owner access");
            expect(sql).not.toContain(
                "Organization owners and admins always have owner access",
            );
            // A wall must survive a promotion to admin.
            expect(sql).toContain("if new.role = 'owner' then");
            expect(sql).not.toContain("if new.role in ('owner', 'admin') then");
        });

        it("constrains visibility, and keeps personal items private", () => {
            for (const table of ["projects", "workflows"]) {
                expect(sql).toContain(`${table}_visibility_check`);
                expect(sql).toContain(`${table}_visibility_scope_check`);
            }
            expect(sql).toContain("check (visibility in ('private', 'organization'))");
            expect(sql).toContain("check (visibility = 'private' or org_id is not null)");
        });

        it("labels scope from visibility and grants, never from membership alone", () => {
            // An organization's private project used to be labelled
            // 'organization' simply for having an org_id.
            expect(sql).not.toMatch(/when vp\.org_id is not null then 'organization'/);
            expect(sql).not.toMatch(/when w\.org_id is not null then 'organization'/);
            expect(sql).not.toContain("'organization'::text as access_scope");
            expect(sql).toContain(
                "public.project_access_scope(vp.id, vp.org_id, vp.visibility) as access_scope",
            );
            expect(sql).toContain(
                "public.workflow_access_scope(w.id, w.org_id, w.visibility) as access_scope",
            );
            // A denial is not sharing.
            expect(roleFunction(sql, "project_access_scope")).toContain(
                "o.role <> 'deny'",
            );
            expect(roleFunction(sql, "workflow_access_scope")).toContain(
                "o.role <> 'deny'",
            );
        });
    });

    it("makes existing organization content public, once", () => {
        // Nobody loses access on upgrade...
        expect(migration).toMatch(
            /update public\.workflows\s+set visibility = 'organization'\s+where org_id is not null/,
        );
        expect(migration).toMatch(
            /update public\.projects\s+set visibility =\s+case when org_id is not null then 'organization' else 'private' end/,
        );
        // ...and a second run cannot re-publish what has since been made
        // private: the backfill sits inside the branch that adds the column.
        const guard = migration.indexOf("and column_name = 'visibility'");
        const addColumn = migration.indexOf("add column visibility");
        const backfill = migration.indexOf("update public.projects");
        const endOfBranch = migration.indexOf("end if;");
        expect(guard).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(addColumn);
        expect(addColumn).toBeLessThan(backfill);
        expect(backfill).toBeLessThan(endOfBranch);
    });
});

it("keeps at least one owner per organization in SQL", () => {
    const schema = readFileSync(resolve(ROOT, "migrations/0110_org_owner_role.sql"), "utf8");
    const migration = readFileSync(
        resolve(ROOT, "migrations/0110_org_owner_role.sql"),
        "utf8",
    );
    for (const sql of [schema, migration]) {
        expect(sql).toContain("check (role in ('owner', 'admin', 'member'))");
        expect(sql).toContain("org_members_last_owner_guard");
        expect(sql).toContain("An organization must keep at least one owner");
    }
    // The guard the owner one replaces must not survive on either path: left
    // in place it refuses to move a sole admin off 'admin', which is the
    // backfill, and afterwards it would demand an admin no rule requires.
    expect(migration).toContain(
        "drop trigger if exists org_members_last_admin_guard on public.org_members",
    );
    expect(migration).toContain(
        "drop function if exists public.org_members_protect_last_admin()",
    );
    // The new guard is installed before the backfill runs.
    expect(migration.indexOf("create trigger org_members_last_owner_guard"))
        .toBeLessThan(migration.indexOf("update public.org_members m"));
    // Invitations never carry ownership.
    expect(SCHEMA).toContain("ARRAY['admin'::text, 'member'::text]");
});

it("backfills owners only into organizations that have none", () => {
    const migration = readFileSync(
        resolve(ROOT, "migrations/0110_org_owner_role.sql"),
        "utf8",
    );
    const backfill = migration.slice(
        migration.indexOf("update public.org_members m"),
        migration.indexOf("-- 4. Content access"),
    );
    expect(backfill).toContain("set role = 'owner'");
    expect(backfill).toContain("where m.role = 'admin'");
    // Without this guard a second run promotes every admin an owner has
    // appointed since the first.
    expect(backfill).toMatch(/and not exists \([\s\S]*existing_owner\.role = 'owner'/);
});
