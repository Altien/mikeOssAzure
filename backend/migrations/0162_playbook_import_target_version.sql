-- Dev forward candidate for source180 19fb8ea19d89cda5057508eaff1ddc3095b28bbb.
-- Dated source: backend/migrations/20261020_03_playbook_import_target_version.sql
-- Provisional 180 order 1; allocate a new canonical numbered file at that pick.
-- Native runner owns the transaction. This schema alone is not lifecycle integration.

-- Migration date: 2026-10-20
-- A replacement import records the version of the playbook it replaces (its
-- updated_at when the import began) and saves its compiled content only over
-- that version, so an edit made while it compiles is never silently lost.
-- While such an import runs, content writes to its playbook are refused; the
-- partial index serves that check on every autosave.
-- RECONCILE at actual Dev179: target_updated_at is a snapshot token, not a
-- database-enforced lock. Replacement must UPDATE ... WHERE updated_at=target
-- and require a returned row. The upstream legacy NULL-target branch must
-- return recoverable conflict/retry, preserving current content and cleaning
-- unused staged keys. Never authorize an unguarded replacement overwrite.
alter table public.playbook_imports
  add column if not exists target_updated_at timestamptz;
create index if not exists idx_playbook_imports_running_playbook
  on public.playbook_imports(playbook_id)
  where status = 'running';

revoke all privileges on table public.playbook_imports from public, web_anon, authenticated;
grant select, insert, update, delete on public.playbook_imports to service_role;
notify pgrst, 'reload schema';
