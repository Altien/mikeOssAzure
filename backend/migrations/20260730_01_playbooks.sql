create table if not exists public.playbooks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
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
  user_id uuid not null references auth.users(id) on delete cascade,
  version_number integer not null,
  content_json jsonb not null,
  created_at timestamptz not null default now(),
  unique(playbook_id, version_number)
);

create table if not exists public.playbook_runs (
  id uuid primary key default gen_random_uuid(),
  playbook_id uuid not null references public.playbooks(id) on delete cascade,
  version_id uuid not null references public.playbook_versions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
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

alter table public.playbooks enable row level security;
alter table public.playbook_versions enable row level security;
alter table public.playbook_runs enable row level security;
revoke all privileges on table public.playbooks, public.playbook_versions,
  public.playbook_runs from anon, authenticated;
grant select, insert, update, delete on public.playbooks,
  public.playbook_versions, public.playbook_runs to service_role;
