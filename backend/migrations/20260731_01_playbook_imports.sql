create table if not exists public.playbook_imports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
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
alter table public.playbook_imports enable row level security;
revoke all privileges on table public.playbook_imports from anon, authenticated;
grant select, insert, update, delete on public.playbook_imports to service_role;
