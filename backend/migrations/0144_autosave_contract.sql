-- Dev candidate for source161 c1f8258b31b4f77bc2967032257aecf16b907bfc.
-- Upstream dated source: backend/migrations/20261017_01_playbook_autosave_workspaces.sql
-- Staging order 03; allocate a fresh canonical number after actual Dev160.
-- Native migration runner owns the transaction. Foundation only; full unit needs165/180.

-- The preceding expand migration retains the old representation. Verify its
-- snapshot backfill before contracting; missing snapshots abort this file.
do $playbook_backfill_required$
begin
  if exists(select 1 from public.playbook_runs where content_json is null) then
    raise exception 'Playbook run snapshots must be backfilled before contracting versions';
  end if;
end;
$playbook_backfill_required$;

alter table public.playbook_runs alter column content_json set not null;
alter table public.playbook_runs drop column if exists version_id;
alter table public.playbooks drop column if exists published_version_id;
alter table public.playbooks drop column if exists status;
drop table if exists public.playbook_versions;

-- Existing private service-role-only table grants remain in place.

notify pgrst, 'reload schema';
