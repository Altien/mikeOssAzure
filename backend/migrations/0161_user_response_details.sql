-- Dev source179 candidate d9c0f573d41d01dd5acda0103c4024b9ce505a68
-- Dated mapping: backend/migrations/20261021_03_user_response_details.sql
-- Provisional order within source 1; reconcile actual176/177/178 numbering.
-- Native canonical runner owns the transaction; no parallel schema history.

-- Migration date: 2026-10-21
-- Settings > Features > Response details: whether each response and subagent
-- shows the model, reasoning effort and token count it used. Off by default.
alter table public.user_profiles
  add column if not exists response_details_visible boolean not null default false;

revoke all on public.user_profiles from public, web_anon, authenticated;
grant select,insert,update,delete on public.user_profiles to service_role;

notify pgrst, 'reload schema';
