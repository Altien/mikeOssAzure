-- Migration date: 2026-08-28

alter table public.user_profiles
  add column if not exists transparent_tables boolean not null default true;

alter table public.user_profiles
  alter column transparent_tables set default true;
