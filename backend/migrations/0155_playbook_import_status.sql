-- Dev forward candidate for source165 3eec266319d87e42b38805aebb6f771753810d42.
-- Dated source: backend/migrations/20261020_01_playbook_import_status.sql
-- Provisional 165 order 4; allocate a new canonical numbered file at that pick.
-- Native runner owns the transaction. This schema alone is not lifecycle integration.

-- Migration date: 2026-10-20
-- A playbook import compiles apart from the request that started it, so the
-- page can be left and come back. The attempt row is what the page reads to
-- follow it; it records the workspace so only that workspace shows it.
alter table public.playbook_imports
  add column if not exists org_id uuid references public.organizations(id) on delete cascade;
create index if not exists idx_playbook_imports_user_status
  on public.playbook_imports(user_id, status, started_at desc);

-- RECONCILE with actual Dev164's final123/124/138 canonical lifecycle guard.
-- Use the same insertion/org-move serialization as other organization rows;
-- ordinary content access remains with the named domain service facade.
do $playbook_import_org_guard$
begin
  if to_regprocedure('public.require_active_organization()') is null then
    raise exception 'Playbook import workspace writes require the canonical active organization guard';
  end if;
end;
$playbook_import_org_guard$;
drop trigger if exists require_active_organization on public.playbook_imports;
create trigger require_active_organization before insert or update of org_id on public.playbook_imports
  for each row execute function public.require_active_organization();

revoke all privileges on table public.playbook_imports from public, web_anon, authenticated;
grant select, insert, update, delete on public.playbook_imports to service_role;
notify pgrst, 'reload schema';
