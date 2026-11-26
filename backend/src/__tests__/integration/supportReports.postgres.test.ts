// Regression test for migration 0200 (support reports). Replays the real
// numbered migrations with the standard runner as a non-superuser,
// non-BYPASSRLS migration role, writes reports as tenant_app and reads them
// through the cp_* functions as control_plane.
//
// Opt in exactly as uploadClaimsAsTenant.postgres.test.ts describes:
//
//   docker run -d --name mike-rls-test -e POSTGRES_PASSWORD=pw -p 55441:5432 postgres:16
//   $env:MIKE_TENANT_RLS_TEST_ADMIN_URL = "postgres://postgres:pw@localhost:55441/postgres"
//   npx vitest run src/__tests__/integration/supportReports.postgres.test.ts --testTimeout=60000
//   docker rm -f mike-rls-test
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrationCommand } from "../../scripts/migrationLedger";

const adminUrl = process.env.MIKE_TENANT_RLS_TEST_ADMIN_URL;
const quiet = { info: () => {}, warn: () => {}, error: console.error };
const MIGRATOR = "mike_rls_test_migrator";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PROJECT = id(1);
const OTHER_PROJECT = id(2);
const CHAT = id(10);
const SOLO_CHAT = id(11);
const OTHER_CHAT = id(12);
// Messages in CHAT, oldest first. REPORTED is the cut-off.
const [U1, A1, U2, REPORTED, U3, A3] = [101, 102, 103, 104, 105, 106].map(id);
const SOLO_USER = id(111);
const SOLO_ANSWER = id(112);
const OTHER_ANSWER = id(121);
const [DOC, OTHER_DOC, SOLO_DOC] = [201, 202, 203].map(id);
const CONSENT = "I allow the support team to inspect this conversation.";

describe.skipIf(!adminUrl)("support reports (0200)", () => {
  const database = `mike_rls_test_${process.pid}_${Date.now()}`;
  const password = randomBytes(12).toString("hex");
  let admin: Client;
  let db: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname='web_anon') then create role web_anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
      if not exists (select 1 from pg_roles where rolname='${MIGRATOR}') then
        create role ${MIGRATOR} login nosuperuser nobypassrls createrole createdb;
      end if;
    end $$`);
    await admin.query(`alter role ${MIGRATOR} with login password '${password}' nosuperuser nobypassrls createrole createdb`);
    await admin.query(`grant web_anon, authenticated, service_role to ${MIGRATOR} with admin option`);
    await admin.query(`create database ${database} owner ${MIGRATOR}`);
    const url = new URL(adminUrl!);
    url.username = MIGRATOR; url.password = password; url.pathname = `/${database}`;
    db = new Client({ connectionString: url.toString() });
    await db.connect();
    await expect(runMigrationCommand(db, { kind: "up" }, path.resolve(__dirname, "../../../migrations"), quiet)).resolves.toBe(0);
    // The migrator's implicit creator grants carry no SET option; this lets
    // the test SET ROLE to the request and control-plane roles.
    await admin.query(`grant tenant_app, control_plane to ${MIGRATOR} with set true`);
    await db.query("set role service_role");
    const gaps = await db.query(`select (select count(*) from app.tenant_rls_gaps())::int as rls,
      (select count(*) from app.control_plane_gaps())::int as cp`);
    await db.query("reset role");
    expect(gaps.rows[0]).toEqual({ rls: 0, cp: 0 });
  }, 600_000);

  afterAll(async () => {
    await db?.end().catch(() => {});
    if (admin) {
      await admin.query(`revoke set option for tenant_app, control_plane from ${MIGRATOR}`).catch(() => {});
      await admin.query(`drop database if exists ${database} with (force)`).catch(() => {});
      await admin.end().catch(() => {});
    }
  });

  const asPlatform = async () => {
    await db.query("set local role service_role");
    await db.query("select set_config('request.jwt.claims', '', true)");
  };
  const asTenant = async (tenant: string, user = "u-1") => {
    await db.query("set local role tenant_app");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: tenant, sub: user })]);
  };
  const asControlPlane = () => db.query("set local role control_plane");
  const code = (promise: Promise<unknown>) => promise.then(() => "ok", (error: { code?: string }) => error.code);
  // The statement must start after the savepoint, so callers pass a thunk.
  const attempt = async (run: () => Promise<unknown>) => {
    await db.query("savepoint s");
    const result = await code(run());
    await db.query("rollback to savepoint s");
    return result;
  };

  beforeEach(async () => {
    await db.query("begin");
    await asPlatform();
    await db.query(`insert into public.tenants (tenant_id, status) values ('sr-a','active'), ('sr-b','active')`);
    await db.query(`insert into public.projects (id, tenant_id, user_id, name) values ($1,'sr-a','u-1','P'), ($2,'sr-a','u-1','Q')`, [PROJECT, OTHER_PROJECT]);
    await db.query(`insert into public.chats (id, tenant_id, project_id, user_id) values
      ($1,'sr-a',$2,'u-1'), ($3,'sr-a',null,'u-1'), ($4,'sr-b',null,'u-9')`, [CHAT, PROJECT, SOLO_CHAT, OTHER_CHAT]);
    const messages: Array<[string, string, string, string, number]> = [
      [U1, CHAT, "user", "Question one", 60], [A1, CHAT, "assistant", "Answer one", 59],
      [U2, CHAT, "user", "Question two", 50], [REPORTED, CHAT, "assistant", "Secret answer two", 49],
      [U3, CHAT, "user", "Later question", 40], [A3, CHAT, "assistant", "Later answer", 39],
      [SOLO_USER, SOLO_CHAT, "user", "Solo question", 30], [SOLO_ANSWER, SOLO_CHAT, "assistant", "Solo answer", 29],
    ];
    for (const [messageId, chatId, role, text, minutesAgo] of messages) {
      await db.query(`insert into public.chat_messages (id, tenant_id, chat_id, role, content, author_user_id, created_at, files)
        values ($1,'sr-a',$2,$3,to_jsonb($4::text),'u-1',now() - make_interval(mins => $5),$6)`,
        [messageId, chatId, role, text, minutesAgo,
          messageId === SOLO_USER ? JSON.stringify([{ filename: "solo.pdf", document_id: SOLO_DOC }]) : null]);
    }
    await db.query(`insert into public.chat_messages (id, tenant_id, chat_id, role, content) values ($1,'sr-b',$2,'assistant','"b"')`,
      [OTHER_ANSWER, OTHER_CHAT]);
    for (const [docId, projectId, n] of [[DOC, PROJECT, 301], [OTHER_DOC, OTHER_PROJECT, 302], [SOLO_DOC, null, 303]] as const) {
      await db.query(`insert into public.documents (id, tenant_id, project_id, user_id) values ($1,'sr-a',$2,'u-1')`, [docId, projectId]);
      await db.query(`insert into public.document_versions (id, tenant_id, document_id, storage_path, filename, version_number)
        values ($1::uuid,'sr-a',$2,'blob/' || $1::text,'doc.pdf',1)`, [id(n), docId]);
      await db.query("update public.documents set current_version_id = $1 where id = $2", [id(n), docId]);
      await db.query(`insert into public.document_version_texts (version_id, tenant_id, source_revision, status, text_content)
        select v.id, v.tenant_id, v.text_revision, 'ready', 'Text of ' || v.document_id from public.document_versions v where v.id = $1
        on conflict (version_id) do update set source_revision = excluded.source_revision, status = 'ready',
          text_content = excluded.text_content`, [id(n)]);
    }
    await db.query(`insert into public.llm_usage_events (tenant_id, user_id, feature, provider, model, outcome, input_tokens, created_at)
      values ('sr-a','u-1','chat','p','m','completed',11,now() - interval '48 minutes'),
             ('sr-a','u-1','chat','p','m','failed',22,now() - interval '38 minutes')`);
  });
  afterEach(async () => { await db.query("rollback"); });

  async function report(chatId = CHAT, messageId = REPORTED, consent = true): Promise<string> {
    await asTenant("sr-a");
    const { rows } = await db.query(`insert into public.support_reports
      (user_id, chat_id, message_id, description, allow_conversation, allow_documents, consent_text)
      values ('u-1',$1,$2,'It cited the wrong clause',$3,$3,$4) returning id`,
      [chatId, messageId, consent, consent ? CONSENT : null]);
    return rows[0].id;
  }
  const cp = async (sql: string, params: unknown[]) => {
    await asControlPlane();
    return db.query(sql, params);
  };
  const logCount = async (reportId: string) => {
    await asPlatform();
    return (await db.query("select count(*)::int as n from public.support_access_log where report_id = $1", [reportId])).rows[0].n;
  };

  it("derives project, timestamps and a 14-day expiry in the database", async () => {
    const reportId = await report();
    await asPlatform();
    const { rows } = await db.query(`select tenant_id, project_id, consent_text, withdrawn_at,
      round(extract(epoch from access_expires_at - created_at) / 86400) as days from public.support_reports where id = $1`, [reportId]);
    expect(rows[0]).toEqual({ tenant_id: "sr-a", project_id: PROJECT, consent_text: CONSENT, withdrawn_at: null, days: "14" });
    const without = await report(CHAT, A1, false);
    expect((await db.query("select access_expires_at from public.support_reports where id = $1", [without])).rows[0].access_expires_at).toBeNull();
  });

  it("refuses a user message, a message from another chat, another tenant's chat and consent without wording", async () => {
    await asTenant("sr-a");
    const insert = (chatId: string, messageId: string, consent: string | null = CONSENT) => db.query(`insert into public.support_reports
      (user_id, chat_id, message_id, description, allow_conversation, allow_documents, consent_text)
      values ('u-1',$1,$2,'d',true,true,$3)`, [chatId, messageId, consent]);
    expect(await attempt(() => insert(CHAT, U2))).toBe("23503");
    expect(await attempt(() => insert(CHAT, SOLO_ANSWER))).toBe("23503");
    expect(await attempt(() => insert(OTHER_CHAT, OTHER_ANSWER))).not.toBe("ok");
    expect(await attempt(() => insert(CHAT, REPORTED, null))).toBe("23514");
  });

  it("makes withdrawal one-way and everything else immutable; tenants never see each other's reports", async () => {
    const reportId = await report();
    await db.query("update public.support_reports set withdrawn_at = now() where id = $1", [reportId]);
    const first = (await db.query("select withdrawn_at from public.support_reports where id = $1", [reportId])).rows[0].withdrawn_at;
    expect(first).not.toBeNull();
    await db.query("update public.support_reports set withdrawn_at = null where id = $1", [reportId]);
    expect((await db.query("select withdrawn_at from public.support_reports where id = $1", [reportId])).rows[0].withdrawn_at).toEqual(first);
    expect(await attempt(() => db.query("update public.support_reports set allow_documents = false where id = $1", [reportId]))).toBe("42501");
    await asTenant("sr-b", "u-9");
    expect((await db.query("select count(*)::int as n from public.support_reports")).rows[0].n).toBe(0);
  });

  it("gives control_plane the functions only, never the tables", async () => {
    await report();
    await asControlPlane();
    expect(await attempt(() => db.query("select * from public.support_reports"))).toBe("42501");
    expect(await attempt(() => db.query("select * from public.support_access_log"))).toBe("42501");
    await asTenant("sr-a");
    expect(await attempt(() => db.query("select public.cp_list_support_reports()"))).toBe("42501");
  });

  it("lists reports with their description and live state", async () => {
    const reportId = await report();
    const { rows } = await cp("select * from public.cp_list_support_reports(null, 'sr-a', 10)", []);
    expect(rows).toEqual([expect.objectContaining({ report_id: reportId, tenant_id: "sr-a", project_id: PROJECT,
      message_id: REPORTED, description: "It cited the wrong clause", access_live: true })]);
    expect((await cp("select * from public.cp_list_support_reports(now(), null, 10)", [])).rows).toEqual([]);
  });

  it("reads a content-free trace up to the reported response, even without consent, and logs it", async () => {
    const reportId = await report(CHAT, REPORTED, false);
    const { rows } = await cp("select public.cp_read_support_report($1, 'agent@altien') as r", [reportId]);
    const result = rows[0].r;
    expect(result.report).toMatchObject({ report_id: reportId, access_live: false, description: "It cited the wrong clause" });
    expect(result.trace.messages.map((m: { message_id: string }) => m.message_id)).toEqual([U1, A1, U2, REPORTED]);
    expect(result.trace.usage.map((u: { input_tokens: number }) => u.input_tokens)).toEqual([11]);
    const text = JSON.stringify(result.trace);
    for (const secret of ["Question", "answer", "Later"]) expect(text).not.toContain(secret);
    expect(await logCount(reportId)).toBe(1);
    await asControlPlane();
    expect(await attempt(() => db.query("select public.cp_read_support_report($1, ' ')", [reportId]))).toBe("22023");
    expect(await attempt(() => db.query("select public.cp_read_support_report($1, 'a')", [id(999)]))).toBe("23503");
  });

  it("reads the conversation up to and including the reported response, nothing after", async () => {
    const reportId = await report();
    const { rows } = await cp("select message_id, content from public.cp_read_support_conversation($1, 'agent')", [reportId]);
    expect(rows.map((r) => r.message_id)).toEqual([U1, A1, U2, REPORTED]);
    expect(JSON.stringify(rows)).not.toContain("Later");
    expect(await logCount(reportId)).toBe(1);
  });

  it("refuses conversation and documents without consent, after withdrawal and after expiry", async () => {
    const noConsent = await report(CHAT, A1, false);
    await asControlPlane();
    expect(await attempt(() => db.query("select * from public.cp_read_support_conversation($1, 'agent')", [noConsent]))).toBe("42501");
    expect(await attempt(() => db.query("select * from public.cp_list_support_documents($1, 'agent')", [noConsent]))).toBe("42501");

    const withdrawn = await report();
    await db.query("update public.support_reports set withdrawn_at = now() where id = $1", [withdrawn]);
    await asControlPlane();
    expect(await attempt(() => db.query("select * from public.cp_read_support_conversation($1, 'agent')", [withdrawn]))).toBe("42501");
    expect(await attempt(() => db.query("select public.cp_read_support_document($1, $2, 'agent')", [withdrawn, DOC]))).toBe("42501");

    const expired = await report();
    await db.query("reset role");
    await db.query("alter table public.support_reports disable trigger guard_support_report");
    await db.query("update public.support_reports set access_expires_at = now() - interval '1 second' where id = $1", [expired]);
    await db.query("alter table public.support_reports enable trigger guard_support_report");
    await asControlPlane();
    expect(await attempt(() => db.query("select * from public.cp_read_support_conversation($1, 'agent')", [expired]))).toBe("42501");
    expect(await attempt(() => db.query("select * from public.cp_list_support_documents($1, 'agent')", [expired]))).toBe("42501");
    expect(await logCount(noConsent) + await logCount(withdrawn) + await logCount(expired)).toBe(0);
  });

  it("exposes only the project's documents, with their extracted text", async () => {
    const reportId = await report();
    const listed = await cp("select document_id, text_status from public.cp_list_support_documents($1, 'agent')", [reportId]);
    expect(listed.rows).toEqual([{ document_id: DOC, text_status: "ready" }]);
    const { rows } = await cp("select public.cp_read_support_document($1, $2, 'agent') as d", [reportId, DOC]);
    expect(rows[0].d).toMatchObject({ document_id: DOC, version_id: id(301), storage_path: `blob/${id(301)}`,
      text_status: "ready", text_content: `Text of ${DOC}` });
    await asControlPlane();
    expect(await attempt(() => db.query("select public.cp_read_support_document($1, $2, 'agent')", [reportId, OTHER_DOC]))).toBe("23503");
    expect(await attempt(() => db.query("select public.cp_read_support_document($1, $2, 'agent')", [reportId, SOLO_DOC]))).toBe("23503");
    expect(await logCount(reportId)).toBe(2);
  });

  it("exposes a standalone chat's attached documents only", async () => {
    const reportId = await report(SOLO_CHAT, SOLO_ANSWER);
    const listed = await cp("select document_id from public.cp_list_support_documents($1, 'agent')", [reportId]);
    expect(listed.rows).toEqual([{ document_id: SOLO_DOC }]);
  });

  it("keeps the access log append-only", async () => {
    const reportId = await report();
    await cp("select public.cp_read_support_report($1, 'agent')", [reportId]);
    await asPlatform();
    expect(await attempt(() => db.query("delete from public.support_access_log where report_id = $1", [reportId]))).toBe("42501");
    expect(await attempt(() => db.query("update public.support_access_log set actor = 'x' where report_id = $1", [reportId]))).toBe("42501");
  });
});
