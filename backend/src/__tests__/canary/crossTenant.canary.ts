// Multi-tenant issue 009: the cross-tenant canary. Seeds two tenants with
// identical fixtures (same user id and email in both), then calls every
// route buildApp() registers as tenant A with tenant B's ids and payloads.
// Runs against real PostgREST + Postgres: `npm run test:canary` (see
// vitest.canary.config.ts). Passes only with issue 008's forced RLS
// (migration 0180) applied.

import { randomUUID } from "node:crypto";
import { Client } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthPrincipal } from "../../lib/auth/types";
import {
  readInstallFallback,
  removeTenants,
  seedTenant,
  tenantFingerprint,
  tenantTables,
  type TenantFixture,
} from "./fixtures";
import { listRoutes, routeKey } from "./routeInventory";
import { callOrder, EXEMPT_ROUTES, planCall } from "./routePlan";

const { CANARY_USER_ID, CANARY_EMAIL, TOKEN_PREFIX } = vi.hoisted(() => {
  const userId = globalThis.crypto.randomUUID();
  return {
    CANARY_USER_ID: userId,
    CANARY_EMAIL: `canary-${userId.slice(0, 8)}@test.local`,
    TOKEN_PREFIX: "canary-tenant:",
  };
});

// Auth is replaced at the provider layer only: the real requireAuth,
// tenant resolution and tenantAccess run on an entra principal whose `tid`
// is the token's tenant.
vi.mock("../../lib/auth/providers/entra", () => ({
  validateEntraToken: async (token: string) => {
    if (!token.startsWith(TOKEN_PREFIX)) return { ok: false, status: 401, detail: "Invalid token" };
    const principal: AuthPrincipal = {
      provider: "entra",
      userId: CANARY_USER_ID,
      email: CANARY_EMAIL,
      displayName: "Canary",
      tenantId: process.env.TENANCY_MODE === "pooled" ? undefined : token.slice(TOKEN_PREFIX.length),
      ...(process.env.TENANCY_MODE === "pooled" ? { directoryId: token.slice(TOKEN_PREFIX.length), identityKind: "enterprise" as const } : {}),
      groups: ["canary-admins"],
      roles: [],
    };
    return { ok: true, principal };
  },
}));

// This impossible duplicate-user fixture intentionally bypasses only enterprise
// mirror persistence. Real resolver, admission, JWT clients and forced RLS stay on;
// source-bound mirror conflicts are verified with dedicated real SQL checks.
vi.mock("../../lib/tenantMemberships", async (original) => ({
  ...await original<typeof import("../../lib/tenantMemberships")>(),
  mirrorEnterpriseMembership: vi.fn(async () => {}),
}));

import { buildApp } from "../../app";
import { createServerSupabase } from "../../lib/supabase";
import { runWithTenant } from "../../lib/tenantContext";
import { getAccessibleChat, grantChatAccess } from "../../modules/chat/chat.service";
import { createInvitation } from "../../modules/orgs/orgs.service";

const RESPONSE_TIMEOUT_MS = 15_000;

describe("cross-tenant canary", () => {
  const db = new Client({ connectionString: process.env.CANARY_DATABASE_URL });
  const suffix = randomUUID().slice(0, 8);
  const tenantIds = { a: `canary-a-${suffix}`, b: `canary-b-${suffix}` };
  let a: TenantFixture;
  let b: TenantFixture;
  let tables: string[] = [];
  let fallbackTenantId: string | null = null;
  let before: Record<string, string> = {};
  const app = buildApp();

  beforeAll(async () => {
    // Probes provoke many expected 4xx/5xx logs; the failure list is the report.
    for (const level of ["error", "warn", "info", "log"] as const) {
      vi.spyOn(console, level).mockImplementation(() => {});
    }
    await db.connect();
    fallbackTenantId = await readInstallFallback(db);
    const seed = (label: "a" | "b") =>
      seedTenant(db, {
        tenantId: tenantIds[label],
        ...(process.env.TENANCY_MODE === "pooled" ? { directoryId: randomUUID() } : {}),
        userId: CANARY_USER_ID,
        email: CANARY_EMAIL,
        granteeEmail: `grantee-${suffix}@test.local`,
        marker: `canary-${label}-${suffix}-marker`,
      });
    a = await seed("a");
    b = await seed("b");
    tables = await tenantTables(db);
    before = await tenantFingerprint(db, tables, b.tenantId);
  });

  afterAll(async () => {
    if (!tables.length) tables = await tenantTables(db);
    await removeTenants(db, tables, [tenantIds.a, tenantIds.b], fallbackTenantId);
    await db.end();
  });

  const as = (tenant: TenantFixture) => `Bearer ${TOKEN_PREFIX}${tenant.directoryId ?? tenant.tenantId}`;

  // Without this, probes that all fail for an unrelated reason would pass.
  const expectEachTenantSeesOwnFixtures = async () => {
    for (const [self, other] of [[a, b], [b, a]] as const) {
      const res = await request(app).get("/api/projects").set("Authorization", as(self));
      expect(res.status, res.text).toBe(200);
      expect(res.text).toContain(self.ids.project);
      expect(res.text).not.toContain(other.ids.project);
    }
  };

  // Issue 008's migration gate, re-checked after every migration has run: each
  // tenant table has forced RLS and tenant_isolation, tenant_app is confined,
  // and no definer function outside the platform list bypasses RLS.
  it("has no tenant RLS gaps (migration gate)", async () => {
    const { rows } = await db.query<{ object: string; problem: string }>(
      "select object, problem from app.tenant_rls_gaps()",
    );
    expect(rows.map((row) => `${row.object}: ${row.problem}`)).toEqual([]);
  });

  it("serves each tenant its own fixtures (harness check)", expectEachTenantSeesOwnFixtures);

  it("runs audited admin SQL with the tenant role and rolls ownership back", async () => {
    const newOwner = randomUUID();
    const reason = "Canary reassignment " + suffix;
    await db.query("begin");
    try {
      // Only fixture setup uses the platform role; every operation under test
      // uses the real tenant_app grants, signed-claim shape and forced RLS.
      await db.query("set local role service_role");
      await db.query("select cp_add_member($1,$2,'Member')", [a.tenantId, newOwner]);
      await db.query("set local role tenant_app");
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
        tenant_id: a.tenantId, sub: CANARY_USER_ID, app_roles: ["TenantAdmin", "Member"],
      })]);
      const roster = await db.query<{ members: { userId: string; role: string }[] }>(
        "select tenant_admin_members() as members",
      );
      expect(roster.rows[0].members).toContainEqual(expect.objectContaining({ userId: newOwner, role: "Member" }));
      await db.query("select tenant_admin_reassign('project',$1,$2,$3)", [a.ids.project, newOwner, reason]);
      expect((await db.query("select user_id from projects where id = $1", [a.ids.project])).rows)
        .toEqual([{ user_id: newOwner }]);
      const audit = await db.query(
        "select user_id, detail from audit_events where action = 'tenant_admin.owner_reassigned' and project_id = $1 and detail->>'reason' = $2",
        [a.ids.project, reason],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({ user_id: CANARY_USER_ID, detail: {
        actor: CANARY_USER_ID, owner: CANARY_USER_ID, newOwner, reason,
        object: { kind: "project", id: a.ids.project },
      } });
    } finally {
      await db.query("rollback");
    }
  });

  it("preserves an enterprise member's identity source across a control-plane move", async () => {
    const userId = randomUUID();
    const directoryId = randomUUID();
    await db.query("begin");
    try {
      await db.query("set local role service_role");
      await db.query("select cp_link_identity_source($1,$2)", [directoryId, a.tenantId]);
      await db.query("select mirror_enterprise_member($1,$2,$3,'TenantAdmin')", [a.tenantId, userId, directoryId]);
      await db.query("select cp_move_member($1,$2)", [userId, b.tenantId]);
      const { rows } = await db.query(
        "select tenant_id, role, identity_kind, directory_id from tenant_memberships where user_id = $1",
        [userId],
      );
      expect(rows).toEqual([{ tenant_id: b.tenantId, role: "Member", identity_kind: "enterprise", directory_id: directoryId }]);
    } finally {
      await db.query("rollback");
    }
  });

  it("bounds sharing and team invitations to current tenant membership", async () => {
    const originalMode = process.env.TENANCY_MODE;
    const localMember = { id: randomUUID(), email: "same-tenant-" + suffix + "@test.local" };
    const movedMember = { id: randomUUID(), email: "other-tenant-" + suffix + "@test.local" };
    process.env.TENANCY_MODE = "pooled";
    try {
      // Seed committed rows: the service calls below use real PostgREST on
      // separate connections, so uncommitted SQL setup would be invisible.
      await db.query("select cp_add_member($1,$2,'Member')", [a.tenantId, localMember.id]);
      await db.query("select cp_add_member($1,$2,'Member')", [b.tenantId, movedMember.id]);
      for (const [tenant, member] of [[a, localMember], [b, movedMember], [a, movedMember]] as const) {
        await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ tenant_id: tenant.tenantId, sub: member.id })]);
        await db.query("insert into user_profiles(tenant_id,user_id,email) values($1,$2,$3)", [tenant.tenantId, member.id, member.email]);
      }
      // The stale A profile deliberately survives the move to B. RLS alone
      // cannot reject it; tenant_member_exists must check current membership.
      await runWithTenant({ tenantId: a.tenantId, userId: CANARY_USER_ID, roles: ["Member"], pooled: true }, async () => {
        const requestDb = createServerSupabase();
        const accessible = await getAccessibleChat(requestDb, { chatId: a.ids.chat, userId: CANARY_USER_ID, userEmail: CANARY_EMAIL });
        expect(accessible.ok).toBe(true);
        if (!accessible.ok) throw new Error("Canary owner cannot access its own chat");
        const share = (email: string) => grantChatAccess(requestDb, {
          chatId: a.ids.chat, chat: accessible.chat, userId: CANARY_USER_ID, email, role: "viewer",
        });
        expect(await share(movedMember.email)).toMatchObject({ ok: false, kind: "validation", detail: "That person is not a member of your organisation." });
        expect(await share(localMember.email)).toMatchObject({ ok: true, grant: { email: localMember.email, role: "viewer" } });
        const invite = (email: string) => createInvitation(requestDb, {
          actorId: CANARY_USER_ID, actorEmail: CANARY_EMAIL, orgId: a.ids.org, email, role: "member",
        });
        expect(await invite(movedMember.email)).toMatchObject({ ok: false, kind: "validation", detail: "That person is not a member of your organisation" });
        expect(await invite(localMember.email)).toMatchObject({ ok: true });
      });
      const forbiddenGrants = await db.query("select id from chat_access_grants where tenant_id=$1 and chat_id=$2 and email=$3", [a.tenantId, a.ids.chat, movedMember.email]);
      const forbiddenInvites = await db.query("select id from org_invitations where tenant_id=$1 and org_id=$2 and email=$3", [a.tenantId, a.ids.org, movedMember.email]);
      expect(forbiddenGrants.rows).toEqual([]);
      expect(forbiddenInvites.rows).toEqual([]);
    } finally {
      if (originalMode === undefined) delete process.env.TENANCY_MODE; else process.env.TENANCY_MODE = originalMode;
      await db.query("select set_config('request.jwt.claims','',false)");
      await db.query("delete from chat_access_grants where tenant_id=$1 and chat_id=$2 and email=any($3::text[])", [a.tenantId, a.ids.chat, [localMember.email, movedMember.email]]);
      await db.query("delete from org_invitations where tenant_id=$1 and org_id=$2 and email=any($3::text[])", [a.tenantId, a.ids.org, [localMember.email, movedMember.email]]);
      await db.query("delete from audit_events where tenant_id=$1 and action='org.invite.created' and title=any($2::text[])", [a.tenantId, [localMember.email, movedMember.email]]);
      await db.query("delete from memory_files where user_id=any($1::text[])", [[localMember.id, movedMember.id]]);
      await db.query("delete from user_profiles where user_id=any($1::uuid[])", [[localMember.id, movedMember.id]]);
      await db.query("select cp_remove_member($1)", [localMember.id]);
      await db.query("select cp_remove_member($1)", [movedMember.id]);
    }
  });

  it("never answers tenant A with tenant B's data", async () => {
    await expectEachTenantSeesOwnFixtures();
    const calls = listRoutes(app)
      .filter((route) => !(routeKey(route) in EXEMPT_ROUTES))
      // `GET *` is the SPA shell fallback (app.ts, FRONTEND_BUNDLED only):
      // it serves static files, touches no tenant data, and `*` is not a
      // URL supertest can send.
      .filter((route) => route.path !== "*")
      .map((route) => planCall(route, b, randomUUID))
      .sort((x, y) => callOrder(x.route) - callOrder(y.route));
    const bValues = [b.tenantId, ...Object.values(b.ids)];
    const failures: string[] = [];
    const send = (call: (typeof calls)[number]) => {
      const method = call.route.method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
      let req = request(app)[method](call.url)
        .set("Authorization", as(a))
        .timeout({ response: RESPONSE_TIMEOUT_MS, deadline: RESPONSE_TIMEOUT_MS });
      if (call.body) req = req.send(call.body);
      return req;
    };
    // The same route with ids that exist in no tenant.
    const nowhere: TenantFixture = {
      ...b,
      ids: Object.fromEntries(Object.keys(b.ids).map((key) => [key, randomUUID()])) as TenantFixture["ids"],
    };

    for (const call of calls) {
      const key = routeKey(call.route);
      const sent = `${call.url} ${JSON.stringify(call.body ?? {})}`;
      let res: request.Response;
      try {
        res = await send(call);
      } catch (error) {
        failures.push(`${key} → no complete response (${(error as Error).message})`);
        continue;
      }
      const text = res.text ?? "";
      const leaked = [b.marker, ...bValues.filter((value) => !sent.includes(value))].filter((value) => text.includes(value));
      if (leaked.length) failures.push(`${key} → ${res.status} returned tenant B data: ${leaked.join(", ")}`);
      if (call.targetsTenantB && res.status >= 200 && res.status < 300) {
        // An idempotent route (a DELETE that answers 204 for any id) reveals
        // nothing when it answers a row that exists nowhere identically; the
        // fingerprint test below proves it changed none of B's rows.
        const control = await send(planCall(call.route, nowhere, randomUUID)).catch(() => null);
        if (!control || control.status !== res.status || (control.text ?? "") !== text) {
          failures.push(`${key} → ${res.status} for tenant B's row`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps catalogs read-only and adopts separate defaults for one user in two tenants", async () => {
    const catalogId = randomUUID();
    const key = "canary-default-" + suffix;
    await db.query("begin");
    try {
      await db.query(
        "insert into mike_workflows(id,workflow_key,distribution,title,type,prompt_md,content_hash) values($1,$2,'default','Canary catalog','assistant','Original catalog instructions',$3)",
        [catalogId, key, "a".repeat(64)],
      );
      await db.query("set local role tenant_app");
      for (const table of ["mike_workflows", "mike_workflow_assets", "workflow_addons", "workflow_addon_reference_files"]) {
        const { rows } = await db.query("select has_table_privilege(current_user,$1,'SELECT') as readable, has_table_privilege(current_user,$1,'INSERT,UPDATE,DELETE') as writable", [table]);
        expect(rows[0]).toEqual({ readable: true, writable: false });
      }
      await db.query("savepoint catalog_write");
      await expect(db.query("update mike_workflows set title = 'Tenant replacement' where id = $1", [catalogId])).rejects.toMatchObject({ code: "42501" });
      await db.query("rollback to savepoint catalog_write");
      const adopt = async (tenant: TenantFixture) => {
        await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ tenant_id: tenant.tenantId, sub: CANARY_USER_ID })]);
        await db.query("select install_missing_default_workflows($1)", [CANARY_USER_ID]);
        const { rows } = await db.query("select workflow_id from default_workflow_installations where user_id = $1 and default_key = $2", [CANARY_USER_ID, key]);
        expect(rows).toHaveLength(1);
        return rows[0].workflow_id as string;
      };
      const aCopy = await adopt(a);
      const bCopy = await adopt(b);
      expect(aCopy).not.toBe(bCopy);
      expect((await db.query("select id from workflows where id = $1", [aCopy])).rows).toEqual([]);
      await db.query("update workflows set prompt_md = 'Tenant B edits its own copy' where id = $1", [bCopy]);
      expect((await db.query("select prompt_md from mike_workflows where id = $1", [catalogId])).rows[0].prompt_md).toBe("Original catalog instructions");
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ tenant_id: a.tenantId, sub: CANARY_USER_ID })]);
      expect((await db.query("select id from workflows where id = $1", [bCopy])).rows).toEqual([]);
      expect((await db.query("select prompt_md from workflows where id = $1", [aCopy])).rows[0].prompt_md).toBe("Original catalog instructions");
    } finally { await db.query("rollback"); }
  });

  it("leaves tenant B's rows untouched", async () => {
    const after = await tenantFingerprint(db, tables, b.tenantId);
    const changed = tables.filter((table) => after[table] !== before[table]);
    expect(changed).toEqual([]);
  });
});
