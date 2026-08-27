create table if not exists public.legal_monitor_sources (
  id uuid primary key default gen_random_uuid(),
  monitor_id uuid not null references public.legal_monitors(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('rss', 'web')),
  name text not null,
  url text not null,
  category text,
  enabled boolean not null default true,
  etag text,
  last_modified text,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  item_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(monitor_id, kind, url)
);

create index if not exists idx_legal_monitor_sources_monitor
  on public.legal_monitor_sources(monitor_id, created_at);
create index if not exists idx_legal_monitor_sources_user
  on public.legal_monitor_sources(user_id, updated_at desc);

create table if not exists public.legal_monitor_source_items (
  id uuid primary key default gen_random_uuid(),
  monitor_id uuid not null references public.legal_monitors(id) on delete cascade,
  source_id uuid not null references public.legal_monitor_sources(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  external_id text not null,
  canonical_url text,
  title text not null,
  published_at timestamptz,
  summary text,
  content text,
  content_hash text not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_id, external_id)
);

create index if not exists idx_legal_monitor_source_items_pending
  on public.legal_monitor_source_items(monitor_id, processed_at, first_seen_at);
create index if not exists idx_legal_monitor_source_items_source
  on public.legal_monitor_source_items(source_id, published_at desc);

alter table public.legal_monitor_sources enable row level security;
alter table public.legal_monitor_source_items enable row level security;
revoke all privileges on table public.legal_monitor_sources,
  public.legal_monitor_source_items from anon, authenticated;
grant select, insert, update, delete on public.legal_monitor_sources,
  public.legal_monitor_source_items to service_role;
