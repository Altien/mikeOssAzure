import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Organizations, invitations and project organization overrides, over HTTP.
//
// lib/orgs.ts and lib/projectAccess.ts are unit-tested against their own
// fakes; what this file pins down is the part only the router owns — which
// failure kind becomes which status code, who is allowed through each
// endpoint, and the response shapes the web UI is written against.
//
// The Supabase stub here is STATEFUL, so an invitation created through POST
// really is the row a later accept/cancel finds.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

let tables: Record<string, Row[]>;
let idCounter: number;
let currentUser: { id: string; email: string };
// Force one table's writes to fail, so the router's db_error arm can be
// exercised over real HTTP rather than reasoned about.
let writeErrors: Record<string, { message: string; code?: string }>;

function resetState() {
    idCounter = 1;
    writeErrors = {};
    currentUser = { id: "admin-1", email: "admin@firm.example" };
    tables = {
        organizations: [{ id: "org-1", name: "Acme LLP", created_by: "admin-1" }],
        org_members: [
            {
                id: "m-1",
                org_id: "org-1",
                user_id: "admin-1",
                role: "admin",
                created_at: "t1",
            },
            {
                id: "m-2",
                org_id: "org-1",
                user_id: "member-1",
                role: "member",
                created_at: "t2",
            },
        ],
        org_invitations: [],
        user_profiles: [
            {
                user_id: "admin-1",
                email: "admin@firm.example",
                display_name: "Ada",
            },
            {
                user_id: "member-1",
                email: "member@firm.example",
                display_name: "Mel",
            },
        ],
        projects: [
            {
                id: "proj-1",
                user_id: "admin-1",
                org_id: "org-1",
                name: "Matter Alpha",
                created_at: "t1",
            },
        ],
        chats: [
            {
                id: "chat-1",
                user_id: "member-1",
                project_id: "proj-1",
                org_id: "org-1",
                title: "Research thread",
                created_at: "t2",
            },
        ],
        tabular_reviews: [
            {
                id: "review-1",
                user_id: "admin-1",
                project_id: "proj-1",
                org_id: "org-1",
                title: "Disclosure review",
                created_at: "t3",
            },
        ],
        workflows: [
            {
                id: "workflow-1",
                user_id: "admin-1",
                org_id: "org-1",
                title: "Disclosure workflow",
                type: "tabular",
                created_at: "t4",
            },
        ],
        project_access_grants: [],
        project_org_access_overrides: [],
        audit_events: [],
        documents: [],
        project_subfolders: [],
    };
}
resetState();

function query(table: string) {
    const filters: (
        | { type: "eq"; col: string; val: unknown }
        | { type: "neq"; col: string; val: unknown }
        | { type: "in"; col: string; vals: unknown[] }
    )[] = [];
    let op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
    let payload: Row | Row[] | null = null;
    let conflictCols: string[] = [];

    const ensure = () => (tables[table] ??= []);
    const matches = (rows: Row[]) =>
        rows.filter((r) =>
            filters.every((f) => {
                if (f.type === "eq") return r[f.col] === f.val;
                if (f.type === "neq") return r[f.col] !== f.val;
                return f.vals.includes(r[f.col]);
            }),
        );

    function resolveMany(): Promise<{
        data: Row[] | null;
        error: { message: string; code?: string } | null;
    }> {
        const arr = ensure();
        if (op !== "select" && writeErrors[table]) {
            return Promise.resolve({ data: null, error: writeErrors[table] });
        }
        if (op === "insert" || op === "upsert") {
            const rows = Array.isArray(payload) ? payload : [payload as Row];
            const out: Row[] = [];
            for (const r of rows) {
                const existing =
                    op === "upsert" && conflictCols.length > 0
                        ? arr.find((e) =>
                              conflictCols.every((c) => e[c] === r[c]),
                          )
                        : undefined;
                if (existing) {
                    Object.assign(existing, r);
                    out.push(existing);
                } else {
                    const created = {
                        id: `row-${idCounter++}`,
                        created_at: `t${idCounter}`,
                        ...r,
                    };
                    arr.push(created);
                    out.push(created);
                }
            }
            return Promise.resolve({ data: out, error: null });
        }
        const matched = matches(arr);
        if (op === "update") {
            for (const r of matched) Object.assign(r, payload as Row);
            return Promise.resolve({ data: matched, error: null });
        }
        if (op === "delete") {
            tables[table] = arr.filter((r) => !matched.includes(r));
            return Promise.resolve({ data: matched, error: null });
        }
        return Promise.resolve({ data: matched, error: null });
    }

    const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        eq: (col: string, val: unknown) => {
            filters.push({ type: "eq", col, val });
            return builder;
        },
        // `.not(col, "is", null)` — the only negation the routes use.
        not: (col: string, operator: string, val: unknown) => {
            if (operator === "is" && val === null) {
                filters.push({ type: "neq", col, val: null });
            }
            return builder;
        },
        neq: (col: string, val: unknown) => {
            filters.push({ type: "neq", col, val });
            return builder;
        },
        in: (col: string, vals: unknown[]) => {
            filters.push({ type: "in", col, vals });
            return builder;
        },
        insert: (p: Row | Row[]) => {
            op = "insert";
            payload = p;
            return builder;
        },
        upsert: (p: Row | Row[], opts?: { onConflict?: string }) => {
            op = "upsert";
            payload = p;
            conflictCols = (opts?.onConflict ?? "")
                .split(",")
                .map((c) => c.trim())
                .filter(Boolean);
            return builder;
        },
        update: (p: Row) => {
            op = "update";
            payload = p;
            return builder;
        },
        delete: () => {
            op = "delete";
            return builder;
        },
        single: async () => {
            const { data, error } = await resolveMany();
            return { data: data?.[0] ?? null, error };
        },
        maybeSingle: async () => {
            const { data, error } = await resolveMany();
            return { data: data?.[0] ?? null, error };
        },
        then: (
            resolve: (v: {
                data: Row[] | null;
                error: { message: string; code?: string } | null;
            }) => unknown,
            reject?: (e: unknown) => unknown,
        ) => resolveMany().then(resolve, reject),
    };
    return builder;
}

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => ({
        from: (t: string) => query(t),
        rpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
        auth: {
            getUser: () =>
                Promise.resolve({
                    data: { user: { id: currentUser.id } },
                    error: null,
                }),
        },
    })),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = currentUser.id;
        res.locals.userEmail = currentUser.email;
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

vi.mock("../../lib/documentVersions", () => ({
    attachActiveVersionPaths: vi.fn(async () => {}),
    attachLatestVersionNumbers: vi.fn(async () => {}),
    contentSha256: vi.fn(() => "0".repeat(64)),
    loadActiveVersion: vi.fn(async () => null),
}));

import { app } from "../../app";

const AUTH = ["Authorization", "Bearer test"] as const;
const as = (id: string, email: string) => {
    currentUser = { id, email };
};

beforeEach(() => {
    vi.clearAllMocks();
    resetState();
});

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

describe("GET /orgs", () => {
    it("returns each membership with the caller's role and roster size", async () => {
        as("member-1", "member@firm.example");
        const res = await request(app).get("/orgs").set(...AUTH);
        expect(res.status).toBe(200);
        expect(res.body).toEqual([
            expect.objectContaining({
                id: "org-1",
                name: "Acme LLP",
                role: "member",
                member_count: 2,
            }),
        ]);
    });

    it("is empty for someone in no organization — there is no personal org", async () => {
        as("loner", "loner@example.com");
        const res = await request(app).get("/orgs").set(...AUTH);
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });
});

describe("POST /orgs", () => {
    it("creates the org and makes the caller its first admin", async () => {
        as("founder", "founder@new.example");
        const res = await request(app)
            .post("/orgs")
            .set(...AUTH)
            .send({ name: "  New Firm  " });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ name: "New Firm", role: "admin" });
        expect(
            tables.org_members.filter((m) => m.user_id === "founder"),
        ).toEqual([expect.objectContaining({ role: "admin" })]);
    });

    it("400s a blank name", async () => {
        const res = await request(app)
            .post("/orgs")
            .set(...AUTH)
            .send({ name: "   " });
        expect(res.status).toBe(400);
    });
});

describe("org membership", () => {
    it("404s an org the caller does not belong to", async () => {
        as("stranger", "stranger@example.com");
        const res = await request(app).get("/orgs/org-1").set(...AUTH);
        expect(res.status).toBe(404);
    });

    it("lists members with their identity for the roster UI", async () => {
        const res = await request(app).get("/orgs/org-1/members").set(...AUTH);
        expect(res.status).toBe(200);
        expect(res.body).toEqual([
            expect.objectContaining({
                user_id: "admin-1",
                role: "admin",
                email: "admin@firm.example",
                display_name: "Ada",
            }),
            expect.objectContaining({
                user_id: "member-1",
                role: "member",
                email: "member@firm.example",
            }),
        ]);
    });

    it("409s an attempt to demote the last admin", async () => {
        const res = await request(app)
            .patch("/orgs/org-1/members/admin-1")
            .set(...AUTH)
            .send({ role: "member" });
        expect(res.status).toBe(409);
        expect(res.body.detail).toBe(
            "An organization must keep at least one admin.",
        );
    });

    it("403s a plain member trying to re-role somebody", async () => {
        as("member-1", "member@firm.example");
        const res = await request(app)
            .patch("/orgs/org-1/members/admin-1")
            .set(...AUTH)
            .send({ role: "member" });
        expect(res.status).toBe(403);
        expect(res.body.detail).toBe("Only an organization admin can do that.");
    });

    it("lets a member leave on their own (204)", async () => {
        as("member-1", "member@firm.example");
        const res = await request(app)
            .delete("/orgs/org-1/members/member-1")
            .set(...AUTH);
        expect(res.status).toBe(204);
        expect(tables.org_members.map((m) => m.user_id)).toEqual(["admin-1"]);
    });

    it("has no endpoint that adds a member directly", async () => {
        // Membership only ever arrives through an accepted invitation.
        const res = await request(app)
            .post("/orgs/org-1/members")
            .set(...AUTH)
            .send({ email: "someone@example.com", role: "member" });
        expect(res.status).toBe(404);
    });
});

describe("organization workspace", () => {
    it("lists only organization-scoped projects and workflows", async () => {
        as("member-1", "member@firm.example");
        const res = await request(app)
            .get("/orgs/org-1/resources")
            .set(...AUTH);
        expect(res.status).toBe(200);
        expect(res.body.projects).toEqual([
            expect.objectContaining({ id: "proj-1", org_id: "org-1" }),
        ]);
        expect(res.body.workflows).toEqual([
            expect.objectContaining({ id: "workflow-1", org_id: "org-1" }),
        ]);
        expect(res.body).not.toHaveProperty("chats");
        expect(res.body).not.toHaveProperty("reviews");
    });

    it("hides the resource inventory from non-members", async () => {
        as("stranger", "stranger@example.com");
        const res = await request(app)
            .get("/orgs/org-1/resources")
            .set(...AUTH);
        expect(res.status).toBe(404);
    });

    it("requires an admin to empty an organization before deleting it", async () => {
        const res = await request(app)
            .delete("/orgs/org-1")
            .set(...AUTH);
        expect(res.status).toBe(409);
        expect(res.body.detail).toContain("still contains");
        expect(tables.organizations).toHaveLength(1);

        tables.projects = [];
        tables.chats = [];
        tables.tabular_reviews = [];
        tables.workflows = [];
        const emptied = await request(app)
            .delete("/orgs/org-1")
            .set(...AUTH);
        expect(emptied.status).toBe(204);
        expect(tables.organizations).toEqual([]);
    });

    it("refuses organization deletion to a plain member", async () => {
        as("member-1", "member@firm.example");
        const res = await request(app)
            .delete("/orgs/org-1")
            .set(...AUTH);
        expect(res.status).toBe(403);
        expect(tables.organizations).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

async function invite(email: string, role = "member") {
    return request(app)
        .post("/orgs/org-1/invitations")
        .set(...AUTH)
        .send({ email, role });
}

describe("organization invitations", () => {
    it("an admin invites an email, and no membership appears", async () => {
        const res = await invite("New@Hire.example", "admin");
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
            email: "new@hire.example",
            role: "admin",
            status: "pending",
        });
        expect(tables.org_members).toHaveLength(2);
    });

    it("403s a plain member trying to invite", async () => {
        as("member-1", "member@firm.example");
        const res = await invite("new@hire.example");
        expect(res.status).toBe(403);
    });

    it("409s a duplicate live invitation", async () => {
        await invite("new@hire.example");
        const res = await invite("new@hire.example");
        expect(res.status).toBe(409);
    });

    it("400s a malformed address", async () => {
        const res = await invite("not-an-email");
        expect(res.status).toBe(400);
    });

    // 'owner' is a tier this product removed. Answering a request for it with
    // a quiet 'member' invitation and a 201 would tell the caller their
    // choice was honoured when it was replaced, so the retired names get the
    // same 400 that updateMember and project sharing already give.
    it("400s a retired role name rather than quietly downgrading it", async () => {
        for (const role of ["owner", "manager", "editor"]) {
            const res = await request(app)
                .post("/orgs/org-1/invitations")
                .set(...AUTH)
                .send({ email: "new@hire.example", role });
            expect(res.status).toBe(400);
        }
        expect(tables.org_invitations ?? []).toHaveLength(0);
    });

    it("still defaults an omitted role to member", async () => {
        const res = await request(app)
            .post("/orgs/org-1/invitations")
            .set(...AUTH)
            .send({ email: "new@hire.example" });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ role: "member" });
    });

    it("shows an admin the invitation roster, and hides it from members", async () => {
        await invite("new@hire.example");
        const admin = await request(app)
            .get("/orgs/org-1/invitations")
            .set(...AUTH);
        expect(admin.status).toBe(200);
        expect(admin.body).toEqual([
            expect.objectContaining({
                email: "new@hire.example",
                status: "pending",
                invited_by_email: "admin@firm.example",
            }),
        ]);

        as("member-1", "member@firm.example");
        const member = await request(app)
            .get("/orgs/org-1/invitations")
            .set(...AUTH);
        expect(member.status).toBe(403);
    });

    it("surfaces the invitation to its recipient and joins them on accept", async () => {
        const created = await invite("new@hire.example", "admin");
        const invitationId = created.body.id as string;

        as("new-hire", "New@Hire.example");
        const mine = await request(app).get("/user/invitations").set(...AUTH);
        expect(mine.status).toBe(200);
        expect(mine.body).toEqual([
            expect.objectContaining({
                id: invitationId,
                org_id: "org-1",
                org_name: "Acme LLP",
                role: "admin",
            }),
        ]);

        const accepted = await request(app)
            .post(`/user/invitations/${invitationId}/accept`)
            .set(...AUTH);
        expect(accepted.status).toBe(200);
        expect(accepted.body).toEqual({ org_id: "org-1", role: "admin" });
        expect(
            tables.org_members.find((m) => m.user_id === "new-hire"),
        ).toMatchObject({ role: "admin" });
    });

    it("204s a decline and creates no membership", async () => {
        const created = await invite("new@hire.example");
        as("new-hire", "new@hire.example");
        const res = await request(app)
            .post(`/user/invitations/${created.body.id}/decline`)
            .set(...AUTH);
        expect(res.status).toBe(204);
        expect(tables.org_members).toHaveLength(2);
        expect(tables.org_invitations[0].status).toBe("declined");
    });

    it("404s somebody else's invitation rather than confirming it exists", async () => {
        const created = await invite("new@hire.example");
        as("intruder", "intruder@elsewhere.example");
        const res = await request(app)
            .post(`/user/invitations/${created.body.id}/accept`)
            .set(...AUTH);
        expect(res.status).toBe(404);
        expect(tables.org_members).toHaveLength(2);
    });

    it("410s an expired invitation, which is not the same as a missing one", async () => {
        const created = await invite("new@hire.example");
        tables.org_invitations[0].expires_at = new Date(
            Date.now() - 1000,
        ).toISOString();

        as("new-hire", "new@hire.example");
        const res = await request(app)
            .post(`/user/invitations/${created.body.id}/accept`)
            .set(...AUTH);
        expect(res.status).toBe(410);
        expect(res.body.detail).toBe("That invitation has expired.");
        // ...and it is not offered in the recipient's list either.
        const mine = await request(app).get("/user/invitations").set(...AUTH);
        expect(mine.body).toEqual([]);
    });

    it("an admin cancels an invitation, and acceptance then 404s", async () => {
        const created = await invite("new@hire.example");
        const cancelled = await request(app)
            .delete(`/orgs/org-1/invitations/${created.body.id}`)
            .set(...AUTH);
        expect(cancelled.status).toBe(204);

        // 404, not 409: "already answered" would tell the recipient
        // something untrue — an admin withdrew the invitation; they never
        // answered it. The client's 404 copy is written for exactly this:
        // "That invitation is no longer available. It may have been
        // cancelled."
        as("new-hire", "new@hire.example");
        const res = await request(app)
            .post(`/user/invitations/${created.body.id}/accept`)
            .set(...AUTH);
        expect(res.status).toBe(404);
    });

    it("resend pushes the expiry back out", async () => {
        const created = await invite("new@hire.example");
        tables.org_invitations[0].expires_at = new Date(
            Date.now() - 1000,
        ).toISOString();
        const res = await request(app)
            .post(`/orgs/org-1/invitations/${created.body.id}/resend`)
            .set(...AUTH);
        expect(res.status).toBe(200);
        expect(new Date(res.body.expires_at).getTime()).toBeGreaterThan(
            Date.now(),
        );
    });

    it("claim-after-signup: an invitation predating the account still lands", async () => {
        await invite("future@hire.example", "member");
        // A brand-new account whose profile did not exist at invite time.
        as("brand-new", "future@hire.example");
        const mine = await request(app).get("/user/invitations").set(...AUTH);
        expect(mine.body).toHaveLength(1);
        const res = await request(app)
            .post(`/user/invitations/${mine.body[0].id}/accept`)
            .set(...AUTH);
        expect(res.status).toBe(200);
        expect(
            tables.org_members.find((m) => m.user_id === "brand-new"),
        ).toMatchObject({ org_id: "org-1", role: "member" });
    });
});

// ---------------------------------------------------------------------------
// Project organization access overrides
// ---------------------------------------------------------------------------

describe("project organization overrides over HTTP", () => {
    it("an owner assigns an organization member a chosen resource role", async () => {
        const res = await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "member@firm.example", role: "viewer" });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
            user_id: "member-1",
            email: "member@firm.example",
            role: "viewer",
        });
        expect(tables.project_org_access_overrides).toEqual([
            expect.objectContaining({
                project_id: "proj-1",
                user_id: "member-1",
                role: "viewer",
            }),
        ]);
        expect(tables.org_members).toHaveLength(2);
    });

    it("400s an invalid role and self-sharing", async () => {
        const badRole = await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "x@y.example", role: "manager" });
        expect(badRole.status).toBe(400);

        const self = await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "Admin@Firm.example", role: "editor" });
        expect(self.status).toBe(400);
    });

    it("does not allow an organization Admin to be overridden", async () => {
        tables.org_members.push({
            id: "m-3",
            org_id: "org-1",
            user_id: "admin-2",
            role: "admin",
            created_at: "t3",
        });
        tables.user_profiles.push({
            user_id: "admin-2",
            email: "partner@firm.example",
            display_name: "Pat",
        });

        const res = await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "partner@firm.example", role: "deny" });

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe(
            "Organization admins always have owner access",
        );
        expect(tables.project_org_access_overrides).toEqual([]);
    });

    it("403s a member trying to change who has access", async () => {
        as("member-1", "member@firm.example");
        const res = await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "counsel@outside.example", role: "viewer" });
        expect(res.status).toBe(403);
        expect(res.body.detail).toBe(
            "Only a project owner can change who has access.",
        );
    });

    it("lists explicit organization overrides for an owner", async () => {
        await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "member@firm.example", role: "viewer" });

        const res = await request(app)
            .get("/projects/proj-1/access")
            .set(...AUTH);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            scope: "organization",
            org_id: "org-1",
            access_role: "owner",
        });
        expect(res.body.grants).toEqual([
            expect.objectContaining({
                email: "member@firm.example",
                role: "viewer",
            }),
        ]);
    });

    it("keeps the grant roster away from non-admins", async () => {
        // The grant list is the management surface: each row names a
        // recipient, a role and a grantor. Serving it at mere reachability
        // let a single read-only grant — the outside-counsel tier —
        // enumerate the whole team on a matter.
        as("member-1", "member@firm.example");
        const res = await request(app)
            .get("/projects/proj-1/access")
            .set(...AUTH);
        expect(res.status).toBe(403);
        expect(res.body.detail).toBe(
            "Only a project owner can change who has access.",
        );
        expect(res.body.grants).toBeUndefined();
    });

    it("shows organization members and their effective roles", async () => {
        await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "member@firm.example", role: "viewer" });

        as("member-1", "member@firm.example");
        const memberView = await request(app)
            .get("/projects/proj-1/people")
            .set(...AUTH);
        expect(memberView.status).toBe(200);
        expect(memberView.body.members).toEqual([
            expect.objectContaining({
                email: "member@firm.example",
                role: "viewer",
            }),
        ]);
    });

    it("removes an override, restoring the member's organization default", async () => {
        await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "member@firm.example", role: "viewer" });

        const gone = await request(app)
            .delete("/projects/proj-1/access/member%40firm.example")
            .set(...AUTH);
        expect(gone.status).toBe(204);
        expect(tables.project_org_access_overrides).toHaveLength(0);

        const missing = await request(app)
            .delete("/projects/proj-1/access/ghost%40outside.example")
            .set(...AUTH);
        expect(missing.status).toBe(404);
    });

    it("does not let a direct grant cross into an organization project", async () => {
        const grant = await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "counsel@outside.example", role: "owner" });
        expect(grant.status).toBe(400);
        expect(tables.project_access_grants).toHaveLength(0);

        as("outsider", "counsel@outside.example");
        const res = await request(app).get("/projects/proj-1").set(...AUTH);
        expect(res.status).toBe(404);
    });
});

// ---------------------------------------------------------------------------
// The contact fields the permission popups need
// ---------------------------------------------------------------------------

describe("GET /projects/:projectId admin contacts", () => {
    it("names the creator and the org's admins so a refusal can say who to ask", async () => {
        as("member-1", "member@firm.example");
        const res = await request(app).get("/projects/proj-1").set(...AUTH);
        expect(res.status).toBe(200);
        // owner_email was declared on this shape for a long time and always
        // came back null, so the UI's "ask …" line could never render.
        expect(res.body.owner_email).toBe("admin@firm.example");
        expect(res.body.owner_display_name).toBe("Ada");
        expect(res.body.admin_contacts).toEqual([
            expect.objectContaining({
                email: "admin@firm.example",
                source: "creator",
            }),
        ]);
        expect(res.body.access_role).toBe("editor");
    });
});

// ---------------------------------------------------------------------------
// Internal failures do not narrate the database to the caller
// ---------------------------------------------------------------------------

describe("sendOrgFailure db_error", () => {
    it("answers a generic 500 instead of forwarding the Postgres message", async () => {
        const consoleError = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});
        as("admin-1", "admin@firm.example");
        // A realistic Postgres error: it names the schema, the table, the
        // constraint, and quotes the offending row — which in the org tables
        // is somebody's email address.
        writeErrors.organizations = {
            code: "23505",
            message:
                'duplicate key value violates unique constraint "org_invitations_active_unique" ' +
                "DETAIL: Key (org_id, email)=(org-1, partner@firm.example) already exists.",
        };

        const res = await request(app)
            .patch("/orgs/org-1")
            .set(...AUTH)
            .send({ name: "Acme Renamed" });

        expect(res.status).toBe(500);
        expect(res.body).toMatchObject({
            code: "internal_error",
            detail: "Something went wrong. Please try again.",
        });
        const body = JSON.stringify(res.body);
        expect(body).not.toContain("org_invitations_active_unique");
        expect(body).not.toContain("partner@firm.example");
        expect(body).not.toContain("duplicate key");

        // The body above is generic either way, because
        // middleware/internalErrorResponse.ts rewrites EVERY >=500 JSON body
        // as a last line of defence. What this pins is that the router no
        // longer needs saving: the handler itself reports the failure through
        // sendInternalError, so the log is a plain internal error rather than
        // the sanitizer's "I just caught a route leaking" record.
        const tags = consoleError.mock.calls.map(([tag]) => tag);
        expect(tags).toContain("[http/internal-error]");
        expect(tags).not.toContain("[http/sanitized-internal-error]");
        consoleError.mockRestore();
    });

    it("still answers intentional 4xx verdicts with their own copy", async () => {
        as("admin-1", "admin@firm.example");
        // The last-admin invariant is a decision, not an incident: the caller
        // caused it and needs to be told what it was.
        const res = await request(app)
            .delete("/orgs/org-1/members/admin-1")
            .set(...AUTH);
        expect(res.status).toBe(409);
        expect(res.body.detail).toBe(
            "An organization must keep at least one admin.",
        );
    });
});
