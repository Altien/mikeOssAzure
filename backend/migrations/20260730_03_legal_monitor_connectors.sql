alter table public.legal_monitors
  add column if not exists connector_config jsonb not null
  default '{"mode":"agent"}'::jsonb;

create table if not exists public.legal_monitor_connector_items (
  id uuid primary key default gen_random_uuid(),
  monitor_id uuid not null references public.legal_monitors(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  connector_id text not null,
  tool_name text not null,
  external_id text not null,
  payload jsonb not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(monitor_id, connector_id, tool_name, external_id)
);

create index if not exists idx_legal_monitor_connector_items_pending
  on public.legal_monitor_connector_items(monitor_id, processed_at, first_seen_at);
create index if not exists idx_legal_monitor_connector_items_source
  on public.legal_monitor_connector_items(connector_id, tool_name, last_seen_at desc);
alter table public.legal_monitor_connector_items enable row level security;
revoke all privileges on table public.legal_monitor_connector_items
  from anon, authenticated;
grant select, insert, update, delete
  on public.legal_monitor_connector_items to service_role;
