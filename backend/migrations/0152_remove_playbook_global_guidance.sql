-- Dev forward candidate for source165 3eec266319d87e42b38805aebb6f771753810d42.
-- Dated source: backend/migrations/20261018_01_remove_playbook_global_guidance.sql
-- Provisional 165 order 1; allocate a new canonical numbered file at that pick.
-- Native runner owns the transaction. This schema alone is not lifecycle integration.

-- Migration date: 2026-10-18
-- Playbooks no longer have a playbook-wide guidance field; guidance that
-- applies throughout is written as a rule. The application ignores the key
-- already, so drop it from stored playbooks. Runs keep the content they were
-- reviewed with, as a record.
update public.playbooks
set content_json = content_json - 'globalGuidance'
where content_json ? 'globalGuidance';

revoke all privileges on table public.playbooks from public, web_anon, authenticated;
grant select, insert, update, delete on public.playbooks to service_role;
notify pgrst, 'reload schema';
