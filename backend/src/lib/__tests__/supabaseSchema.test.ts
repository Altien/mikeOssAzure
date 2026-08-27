import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const schema = fs.readFileSync(path.resolve(process.cwd(), "schema.sql"), "utf8");

const OPTIONAL_TABLES = [
  "saved_prompts",
  "playbooks",
  "playbook_versions",
  "playbook_runs",
  "playbook_imports",
  "gmail_connections",
  "gmail_oauth_states",
  "legal_monitors",
  "legal_monitor_runs",
  "legal_monitor_sources",
  "legal_monitor_source_items",
  "legal_monitor_connector_items",
  "legal_monitor_documents",
  "support_feedback",
  "workflow_open_source_submissions",
  "contact_messages",
] as const;

describe("fresh Supabase schema", () => {
  it("contains every optional module table", () => {
    for (const table of OPTIONAL_TABLES) {
      expect(schema).toContain(`create table if not exists public.${table}`);
    }
  });

  it("uses JSON and boolean types for structured module values", () => {
    expect(schema).toMatch(/source_types jsonb not null/);
    expect(schema).toMatch(/connector_config jsonb not null/);
    expect(schema).toMatch(/draft_json jsonb not null/);
    expect(schema).toMatch(/categories jsonb not null/);
    expect(schema).toMatch(/scopes jsonb not null/);
    expect(schema).toMatch(/gmail_oauth_states \(\n  id text primary key/);
    expect(schema).toMatch(/email_enabled boolean not null/);
    expect(schema).toMatch(/has_material_updates boolean not null/);
  });

  it("enables RLS and revokes browser access for every module table", () => {
    for (const table of OPTIONAL_TABLES) {
      expect(schema).toContain(
        `alter table public.${table} enable row level security;`,
      );
      expect(schema).toContain(
        `revoke all on public.${table} from anon, authenticated;`,
      );
    }
  });
});
