import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const memory = readFileSync(resolve(root, "migrations/0086_scoped_memory.sql"), "utf8");
const safety = readFileSync(resolve(root, "migrations/0087_memory_safety_boundaries.sql"), "utf8");

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
});
