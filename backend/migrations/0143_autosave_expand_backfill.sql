-- Dev candidate for source161 c1f8258b31b4f77bc2967032257aecf16b907bfc.
-- Upstream dated source: backend/migrations/20261017_01_playbook_autosave_workspaces.sql
-- Staging order 02; allocate a fresh canonical number after actual Dev160.
-- Native migration runner owns the transaction. Foundation only; full unit needs165/180.

-- Migration date: 2026-10-17
-- Playbooks are continuously saved. Each review owns the exact rules it used.
alter table public.playbooks
  add column if not exists org_id uuid references public.organizations(id) on delete cascade,
  add column if not exists visibility text not null default 'private',
  add column if not exists shared_with text[] not null default '{}';
alter table public.playbooks drop constraint if exists playbooks_visibility_check;
alter table public.playbooks add constraint playbooks_visibility_check
  check (visibility in ('private', 'organization') and
    (org_id is not null or visibility = 'private') and
    (org_id is null or cardinality(shared_with) = 0));
create index if not exists idx_playbooks_org_updated on public.playbooks(org_id, updated_at desc);
create index if not exists idx_playbooks_shared_with on public.playbooks using gin(shared_with);

alter table public.playbook_runs add column if not exists content_json jsonb;
do $$
begin
  if exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'playbook_runs' and column_name = 'version_id') then
    update public.playbook_runs r set content_json = v.content_json
      from public.playbook_versions v where r.version_id = v.id and r.content_json is null;
  end if;
end $$;

-- RECONCILE at actual Dev160 with source123/124/138's existing active-org seam.
-- Match the existing resource guard: serialize insertion and organization moves
-- with soft deletion. Ordinary edits retain the caller service access checks.
do $playbook_active_org_required$
begin
  if to_regprocedure('public.require_active_organization()') is null then
    raise exception 'Playbooks require the reconciled organization lifecycle guard';
  end if;
end;
$playbook_active_org_required$;
drop trigger if exists require_active_organization on public.playbooks;
create trigger require_active_organization before insert or update of org_id on public.playbooks
  for each row execute function public.require_active_organization();

notify pgrst, 'reload schema';
