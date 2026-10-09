-- 0023_external_source_cache.sql
--
-- Durable, provider-neutral external-source cache.

create table if not exists public.external_source_cache (
  id uuid primary key default gen_random_uuid(),
  cache_scope text not null,
  owner_user_id text not null,
  project_id uuid references public.projects(id) on delete cascade,
  source_key text not null,
  provider text not null,
  external_id text not null,
  version_id text not null,
  title text not null,
  origin_url text,
  search_tool text not null,
  read_tool text not null,
  content_text text not null,
  content_hash text not null,
  content_bytes bigint not null,
  summary_text text,
  summary_status text not null default 'pending' check (summary_status in (
    'pending',
    'generated',
    'fallback'
  )),
  summary_model text,
  retrieved_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(cache_scope, source_key, version_id, content_hash)
);

create index if not exists idx_external_source_cache_lookup
  on public.external_source_cache(cache_scope, source_key, retrieved_at desc);

create index if not exists idx_external_source_cache_project
  on public.external_source_cache(project_id, retrieved_at desc)
  where project_id is not null;
