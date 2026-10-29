-- Dev forward candidate for source165 3eec266319d87e42b38805aebb6f771753810d42.
-- Dated source: backend/migrations/20261018_02_playbook_run_history_index.sql
-- Provisional 165 order 2; allocate a new canonical numbered file at that pick.
-- Native runner owns the transaction. This schema alone is not lifecycle integration.

-- Migration date: 2026-10-18
-- The sidebar's History pages through a person's playbook runs, newest first.
create index if not exists idx_playbook_runs_user_started
  on public.playbook_runs(user_id, started_at desc);

revoke all privileges on table public.playbook_runs from public, web_anon, authenticated;
grant select, insert, update, delete on public.playbook_runs to service_role;
notify pgrst, 'reload schema';
