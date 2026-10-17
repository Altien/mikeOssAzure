-- Dev candidate for source161 c1f8258b31b4f77bc2967032257aecf16b907bfc.
-- Upstream dated source: backend/migrations/20261016_02_playbooks.sql
-- Staging order 01; allocate a fresh canonical number after actual Dev160.
-- Native migration runner owns the transaction. Foundation only; full unit needs165/180.

-- Migration date: 2026-10-16
-- Contract-review playbooks: drafts, immutable published versions, review
-- runs, and the audit trail for Word imports.

create table if not exists public.playbooks (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  name text not null,
  description text not null default '',
  status text not null default 'draft',
  draft_json jsonb not null,
  published_version_id uuid,
  source_filename text,
  source_storage_key text,
  source_structure_json jsonb,
  import_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_playbooks_user_updated
  on public.playbooks(user_id, updated_at desc);

create table if not exists public.playbook_versions (
  id uuid primary key default gen_random_uuid(),
  playbook_id uuid not null references public.playbooks(id) on delete cascade,
  user_id text not null,
  version_number integer not null,
  content_json jsonb not null,
  created_at timestamptz not null default now(),
  unique(playbook_id, version_number)
);
create index if not exists idx_playbook_versions_playbook
  on public.playbook_versions(playbook_id, version_number desc);

create table if not exists public.playbook_runs (
  id uuid primary key default gen_random_uuid(),
  playbook_id uuid not null references public.playbooks(id) on delete cascade,
  version_id uuid not null references public.playbook_versions(id) on delete cascade,
  user_id text not null,
  model text not null,
  document_name text,
  review_mode text not null,
  status text not null,
  summary text,
  findings_json jsonb,
  error text,
  started_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_playbook_runs_playbook_started
  on public.playbook_runs(playbook_id, started_at desc);

create table if not exists public.playbook_imports (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  filename text not null,
  requested_name text,
  model text not null,
  status text not null,
  stage text not null,
  error text,
  playbook_id uuid references public.playbooks(id) on delete set null,
  started_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_playbook_imports_user_started
  on public.playbook_imports(user_id, started_at desc);


revoke all privileges on table public.playbooks, public.playbook_versions,
  public.playbook_runs, public.playbook_imports from public, web_anon, authenticated;
grant select, insert, update, delete on public.playbooks,
  public.playbook_versions, public.playbook_runs, public.playbook_imports
  to service_role;

notify pgrst, 'reload schema';
