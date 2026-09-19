import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(__dirname, "../../migrations/0093_organization_access_followup.sql"), "utf8").toLowerCase();
const accessTables = [
  "organizations", "org_members", "org_invitations", "project_access_grants",
  "project_org_access_overrides", "chat_access_grants",
  "tabular_review_access_grants", "workflow_org_access_overrides",
];

describe("numbered organization access forward migration", () => {
  it("keeps Dev's text resource identity and private PostgREST authority", () => {
    expect(sql).toContain("p_workflow_user_id text");
    expect(sql).toContain("lower(s.shared_with_email) = lower(p_user_email)");
    expect(sql).not.toMatch(/auth\.users|enable row level security|\bfrom anon\b/i);
    for (const table of accessTables)
      expect(sql).toContain(`revoke all on public.${table} from public, web_anon, authenticated`);
  });

  it("removes bad legacy self-grants using known profile email", () => {
    expect(sql).toContain("delete from public.project_access_grants");
    expect(sql).toContain("delete from public.tabular_review_access_grants");
    expect(sql).toContain("creator.user_id::text = p.user_id");
    expect(sql).toContain("creator.user_id::text = r.user_id");
    expect(sql).toContain("position('@' in trim(email)) <= 1");
  });

  it("archives contained-review shares and normalizes workflow recipients", () => {
    expect(sql).toContain("create table if not exists public.tabular_review_legacy_shares");
    expect(sql).toContain("on conflict (tabular_review_id, email) do nothing");
    expect(sql).toContain("grant select, insert, update, delete");
    expect(sql).toContain("workflow_shares_email_lowercase");
    expect(sql).toContain("case role when 'owner' then 0 when 'editor' then 1 else 2 end");
  });
});
