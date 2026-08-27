-- Per-user switches for optional locally added product capabilities.
alter table public.user_profiles
  add column if not exists feature_flags jsonb not null default '{}'::jsonb;
