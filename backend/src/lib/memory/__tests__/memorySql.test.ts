import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const memory = readFileSync(resolve(root, "migrations/0086_scoped_memory.sql"), "utf8");
const safety = readFileSync(resolve(root, "migrations/0087_memory_safety_boundaries.sql"), "utf8");
const followup = readFileSync(resolve(root, "migrations/0092_memory_followup.sql"), "utf8");

function body(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n$$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe("numbered scoped memory migrations on private PostgREST", () => {
  it("uses text actor identities and explicit Dev roles", () => {
    expect(memory).toMatch(/user_id text/);
    expect(memory).not.toMatch(/auth\.users|auth\.uid\(\)|enable row level security/i);
    expect(memory).toMatch(/web_anon/);
    expect(memory).toMatch(/authenticated/);
    expect(memory).toMatch(/service_role/);
    expect(safety).not.toMatch(/auth\.users|auth\.uid\(\)/);
  });

  it("fences stale curator writes with epoch, revision, and conversation generation", () => {
    const write = body(memory, "write_memory_file");
    expect(write).toContain("memory_job_superseded");
    expect(write).toContain("consolidation.generation <> p_consolidation_generation");
    expect(write).toContain("activity.generation <> p_conversation_generation");
    expect(write).toContain("memory_epoch_conflict");
    expect(write).toContain("memory_revision_conflict");
    expect(write).toContain("last_source_job_id = p_source_job_id");
  });

  it("makes erasure advance the file epoch and revision", () => {
    const wipe = body(memory, "wipe_memory_file");
    expect(wipe).toContain("epoch = target.epoch + 1");
    expect(wipe).toContain("revision = target.revision + 1");
  });

  it("retains generation-token job claims from the Dev queue", () => {
    expect(memory).not.toMatch(/create or replace function public\.claim_db_jobs\(/i);
    expect(memory).not.toMatch(/create or replace function public\.finish_db_job\(/i);
  });

  it("pins app-memory eligibility to a private conversation", () => {
    const check = body(followup, "memory_source_allows_app_memory");
    expect(check).toContain("p_conversation_id");
    expect(check).toContain("chat.org_id is null");
    expect(check).toContain("public.chat_access_grants");
    expect(check).toContain("public.tabular_review_access_grants");
    expect(followup).toContain("drop function if exists public.memory_source_allows_app_memory(text, uuid)");
  });

  it("keeps actor identities as text and uses private PostgREST grants", () => {
    expect(followup).not.toMatch(/auth\.users|auth\.uid\(\)|enable row level security/i);
    expect(body(followup, "lock_memory_conversation_source")).toContain("review_owner_user_id text");
    expect(body(followup, "schedule_memory_consolidation")).toContain("pending_actor_ids text[]");
    expect(followup).toContain("FROM PUBLIC, web_anon, authenticated");
    expect(followup).toContain("TO service_role");
  });

  it("returns conflicts promptly and protects the tabular owner on re-read", () => {
    expect(followup).not.toContain("errcode = '40001'");
    const locked = body(followup, "lock_memory_conversation_source");
    expect(locked).toContain("verified_review_owner_user_id is distinct from review_owner_user_id");
    const schedule = body(followup, "schedule_memory_consolidation");
    expect(schedule).toContain("locked_user_file.user_id = any(pending_actor_ids)");
    expect(schedule).toContain("memory_state_missing");
  });
});

// ---------------------------------------------------------------------------
// A person's memory, per workspace (20261013_02_workspace_memory).
//
// One private file for Personal and one for each team organization the
// person belongs to. A conversation reads and learns only the memory of the
// workspace it is in. Like the checks above, these read the shipped SQL: the
// behaviour itself needs a live Postgres.
// ---------------------------------------------------------------------------

const workspaceMigration = readFileSync(
  resolve(root, "migrations/0122_workspace_memory.sql"),
  "utf8",
);

const schemaSql = workspaceMigration;
const functionBody = body;

describe("per-workspace memory SQL", () => {
  it.each([
    "memory_source_org_id",
    "ensure_user_memory_file",
    "initialize_new_user_memory",
    "memory_source_allows_app_memory",
    "write_memory_file",
    "schedule_memory_consolidation",
    "refresh_memory_file_status",
  ])("a fresh install defines %s exactly as the migration does", (name) => {
    expect(functionBody(schemaSql, name)).toBe(
      functionBody(workspaceMigration, name),
    );
  });

  it.each([
    ["schema", schemaSql],
    ["migration", workspaceMigration],
  ] as const)("%s keeps one file per person per workspace", (_name, sql) => {
    // Null is Personal and nulls are distinct, so one index each.
    expect(sql).toMatch(
      /create unique index if not exists memory_files_user_personal_unique\s+on public\.memory_files\(user_id\) where org_id is null;/,
    );
    expect(sql).toMatch(
      /create unique index if not exists memory_files_user_workspace_unique\s+on public\.memory_files\(user_id, org_id\) where org_id is not null;/,
    );
  });

  it("no longer keeps the one-file-per-person index, which would refuse a second workspace", () => {
    expect(workspaceMigration).toContain(
      "drop index if exists public.memory_files_user_unique;",
    );
    // Dev drift: immutable0122 is corrected by forward0175; infer its existing partial Personal key.
    const initializer = readFileSync(resolve(root, "migrations/0175_personal_memory_initializer_conflict.sql"), "utf8");
    expect(functionBody(initializer, "initialize_new_user_memory")).toContain("on conflict (user_id) where org_id is null do nothing");
    expect(functionBody(schemaSql, "delete_user_private_memories")).not.toContain("on conflict (user_id)");
  });

  it.each([
    ["schema", schemaSql],
    ["migration", workspaceMigration],
  ] as const)(
    "%s ties a workspace memory to the membership, so leaving takes it away",
    (_name, sql) => {
      expect(functionBody(sql, "guard_workspace_memory_membership")).toContain("member.org_id = new.org_id and member.user_id::text = new.user_id");
      expect(functionBody(sql, "guard_workspace_memory_membership")).toContain("for key share");
      expect(functionBody(sql, "cleanup_departed_workspace_memory")).toContain("file.user_id = old.user_id::text");
      expect(functionBody(sql, "cleanup_departed_workspace_memory")).toContain("file.org_id = old.org_id");
    },
  );

  it("gives only a standalone chat in a team organization a workspace", () => {
    const body = functionBody(schemaSql, "memory_source_org_id");
    expect(body).toContain("case when p_surface = 'chat' then");
    expect(body).toContain("and chat.project_id is null");
    expect(body).toContain("and public.org_is_team(chat.org_id)");
  });

  it("lets an organization's chat learn only when it is standalone and its author is still a member", () => {
    const body = functionBody(schemaSql, "memory_source_allows_app_memory");
    expect(body).toMatch(
      /not public\.org_is_team\(chat\.org_id\)\s+or \(\s+chat\.project_id is null\s+and exists \(\s+select 1 from public\.org_members member\s+where member\.org_id = chat\.org_id\s+and member\.user_id::text = p_actor_user_id/,
    );
    // The old rule, which kept every organization chat out, is gone.
    expect(body).not.toContain("and chat.org_id is null");
  });

  it("refuses, under the row lock, a write into any workspace but the conversation's own", () => {
    const body = functionBody(schemaSql, "write_memory_file");
    const lock = body.indexOf("where id = p_memory_file_id\n  for update;");
    const fence = body.indexOf(
      "and target.org_id is distinct from\n        public.memory_source_org_id(p_source_surface, p_source_chat_id)",
    );
    expect(lock).toBeGreaterThan(0);
    expect(fence).toBeGreaterThan(lock);
    expect(body.slice(fence, fence + 240)).toContain("memory_scope_ineligible");
  });

  it("schedules and marks only the actor's file for the conversation's workspace", () => {
    const body = functionBody(schemaSql, "schedule_memory_consolidation");
    expect(body).toContain(
      "workspace_org_id := public.memory_source_org_id(p_surface, p_conversation_id);",
    );
    expect(
      body.match(/org_id is not distinct from workspace_org_id/g),
    ).toHaveLength(2);
    expect(body).toContain(
      "'appOrgId', case when app_enabled then app_file.org_id else null end,",
    );
    // No file is created for somebody by inserting directly any more.
    expect(body).not.toContain(
      "insert into public.memory_files(scope, user_id, enabled)",
    );
  });

  it("does not take a job for one of a person's memories for a job on another", () => {
    const body = functionBody(schemaSql, "refresh_memory_file_status");
    expect(
      body.match(
        /job\.payload->>'appOrgId' is not distinct from target\.org_id::text/g,
      ),
    ).toHaveLength(2);
  });

  it("starts a new workspace memory as the person left their Personal one", () => {
    const body = functionBody(schemaSql, "ensure_user_memory_file");
    expect(body).toMatch(
      /select personal\.enabled from public\.memory_files personal\s+where personal\.scope = 'user'\s+and personal\.user_id = p_user_id\s+and personal\.org_id is null/,
    );
    // ... and gives a non-member nothing.
    expect(body).toMatch(
      /if p_org_id is not null and not exists \(\s+select 1 from public\.org_members member/,
    );
  });

  it("keeps creating one out of reach of signed-in and anonymous callers", () => {
    for (const sql of [schemaSql, workspaceMigration]) {
      for (const signature of [
        "memory_source_org_id(text, uuid)",
        "ensure_user_memory_file(text, uuid)",
      ]) {
        expect(sql).toContain(
          `revoke all on function public.${signature}\n  from public, web_anon, authenticated;`,
        );
      }
    }
  });

  // `migrate.sh baseline` records earlier files without running them. Named
  // one file too far, it leaves a database that says it has the older memory
  // migration and does not; this one then failed half-way down on a function
  // that was never created. It checks first, before changing anything.
  it("checks historical memory prerequisites without rewriting applied SQL", () => {
    const prerequisite = readFileSync(resolve(root, "migrations/0125_memory_prerequisites.sql"), "utf8");
    const guard = prerequisite.indexOf(
      "to_regprocedure('public.memory_project_is_private(uuid)') is null",
    );
    const firstChange = prerequisite.search(
      /^(alter|create|drop|insert|update|delete)\b/m,
    );
    expect(guard).toBeGreaterThan(0);
    expect(firstChange).toBe(-1);
    // It names the missing file and how to apply it.
    expect(prerequisite).toContain(
      "message = 'This database is missing objects from 0092_memory_followup.sql'",
    );
    expect(prerequisite).toContain(
      "documented canonical migration process",
    );
    // The file it sends people to really does create what is checked for.
    for (const name of [
      "memory_project_is_private",
      "delete_user_private_memories",
      "memory_source_allows_app_memory",
    ]) {
      expect(followup).toContain(
        `create or replace function public.${name}(`,
      );
    }
  });
});

// Dev drift: canonical numbered history replaces schema.sql and dated duplicates.
const backendRoot = root;
const scopedSchemaSql = readdirSync(resolve(root, "migrations")).filter(name => /^\d{4}_.*\.sql$/.test(name)).sort()
  .map(name => readFileSync(resolve(root, "migrations", name), "utf8")).join("\n");
const scopedFunctionBody = (sql: string, name: string) => body(sql.slice(sql.lastIndexOf(`create or replace function public.${name}`)), name);
const scopedDeletionMigration = readFileSync(
  resolve(backendRoot, "migrations/0170_workspace_scoped_data_deletion.sql"),
  "utf8",
);

describe("workspace-scoped memory deletion SQL", () => {
  it("a fresh install defines delete_user_private_memories exactly as the migration does", () => {
    expect(scopedFunctionBody(scopedSchemaSql, "delete_user_private_memories")).toBe(
      scopedFunctionBody(scopedDeletionMigration, "delete_user_private_memories"),
    );
  });

  it.each([
    ["schema", scopedSchemaSql],
    ["migration", scopedDeletionMigration],
  ] as const)("%s wipes one workspace's memory, never every workspace's", (_name, sql) => {
    const body = scopedFunctionBody(sql, "delete_user_private_memories");
    expect(body).toContain("p_org_id uuid default null");
    // An organization: only the person's own file there.
    expect(body).toMatch(
      /if p_org_id is not null then[\s\S]*and file\.org_id = p_org_id[\s\S]*return 0;\s+end if;/,
    );
    // Personal: the Personal file alone, not one per organization.
    expect(body).toMatch(
      /where file\.scope = 'user'\s+and file\.user_id = p_user_id\s+and file\.org_id is null/,
    );
    // The one-argument form is replaced, not left beside it to make a
    // one-argument call ambiguous.
    expect(sql).toContain(
      "drop function if exists public.delete_user_private_memories(text);",
    );
    expect(sql).toContain(
      "revoke all on function public.delete_user_private_memories(text, uuid)\n  from public, web_anon, authenticated;",
    );
    expect(sql).toMatch(
      /grant execute\s+on function public\.delete_user_private_memories\(text, uuid\)\s+to service_role;/,
    );
  });
});
