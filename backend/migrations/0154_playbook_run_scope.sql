-- Dev forward candidate for source165 3eec266319d87e42b38805aebb6f771753810d42.
-- Dated source: backend/migrations/20261019_01_playbook_run_scope.sql
-- Provisional 165 order 3; allocate a new canonical numbered file at that pick.
-- Native runner owns the transaction. This schema alone is not lifecycle integration.

-- Migration date: 2026-10-19
-- A run records whether it reviewed every rule or reported only the issues,
-- so an issues-only run is not mistaken for one that found nothing else.
alter table public.playbook_runs
  add column if not exists review_scope text not null default 'full';
alter table public.playbook_runs
  drop constraint if exists playbook_runs_review_scope_check;
alter table public.playbook_runs
  add constraint playbook_runs_review_scope_check
  check (review_scope in ('full', 'issues'));

revoke all privileges on table public.playbook_runs from public, web_anon, authenticated;
grant select, insert, update, delete on public.playbook_runs to service_role;
notify pgrst, 'reload schema';
