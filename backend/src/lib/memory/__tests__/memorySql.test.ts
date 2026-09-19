import { readFileSync } from "node:fs";
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
