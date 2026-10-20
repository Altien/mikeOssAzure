-- Dev source178 candidate e8f73821f0a0ea7b7a665f62cec77043e9706264
-- Dated mapping: backend/migrations/20261021_02_user_subagent_defaults.sql
-- Provisional order within source 2; reconcile actual176/177/178 numbering.
-- Native canonical runner owns the transaction; no parallel schema history.

-- Migration date: 2026-10-21
-- Defaults for subagents from Settings > Model Preferences. The assistant is
-- told them and follows them unless the conversation asks for something else.
alter table public.user_profiles
  add column if not exists subagent_model text,
  add column if not exists subagent_reasoning text;

alter table public.user_profiles
  drop constraint if exists user_profiles_subagent_reasoning_check;
alter table public.user_profiles
  add constraint user_profiles_subagent_reasoning_check
  check (subagent_reasoning in ('none', 'low', 'medium', 'high', 'xhigh', 'max'));

revoke all on public.user_profiles from public, web_anon, authenticated;
grant select,insert,update,delete on public.user_profiles to service_role;

notify pgrst, 'reload schema';
