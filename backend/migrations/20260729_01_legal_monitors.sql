create table if not exists public.legal_monitors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  topic text not null,
  jurisdiction text not null,
  source_types jsonb not null default '[]'::jsonb,
  connector_id text not null default '',
  connector_config jsonb not null default '{"mode":"agent"}'::jsonb,
  model text not null,
  interval_hours integer not null,
  lookback_days integer not null default 14,
  max_items_per_run integer not null default 50,
  alert_email text,
  email_enabled boolean not null default false,
  enabled boolean not null default true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_status text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_legal_monitors_user_updated
  on public.legal_monitors(user_id, updated_at desc);
create index if not exists idx_legal_monitors_due
  on public.legal_monitors(enabled, next_run_at);

create table if not exists public.legal_monitor_runs (
  id uuid primary key default gen_random_uuid(),
  monitor_id uuid not null references public.legal_monitors(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null,
  summary text,
  report text,
  developments jsonb,
  has_material_updates boolean not null default false,
  tool_calls integer not null default 0,
  source_items_count integer not null default 0,
  source_errors jsonb,
  email_status text not null default 'not_requested',
  email_error text,
  error text,
  started_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_legal_monitor_runs_monitor_started
  on public.legal_monitor_runs(monitor_id, started_at desc);
create index if not exists idx_legal_monitor_runs_user_started
  on public.legal_monitor_runs(user_id, started_at desc);

alter table public.legal_monitors enable row level security;
alter table public.legal_monitor_runs enable row level security;
revoke all privileges on table public.legal_monitors, public.legal_monitor_runs
  from anon, authenticated;
grant select, insert, update, delete
  on public.legal_monitors, public.legal_monitor_runs to service_role;
