-- Dev adaptation: metadata repair must include inactive parents too. The native
-- runner provides this file's transaction: any failure rolls back both repaired
-- data and trigger DDL. Never run these statements in a nontransactional loop.
do $workspace_repair_prerequisites$
begin
  if to_regclass('public.chats') is null or to_regclass('public.tabular_reviews') is null
     or to_regclass('public.documents') is null or to_regclass('public.projects') is null then
    raise exception 'Workspace child repair requires canonical0083 tables; repair baseline/history before migrating';
  end if;
end;
$workspace_repair_prerequisites$;

-- These exact child tables only; unrelated tables and triggers remain available.
lock table public.chats, public.tabular_reviews, public.documents in share row exclusive mode;

do $workspace_repair_contracts$
declare child text; child_oid regclass; project_column smallint;
begin
  if to_regprocedure('public.require_active_organization()') is null
     or to_regprocedure('public.sync_project_child_org_id()') is null then
    raise exception 'Workspace child repair requires canonical0083 sync and0131/0135 active-org guards; repair baseline/history first';
  end if;
  if not exists(select 1 from pg_catalog.pg_attribute
      where attrelid='public.projects'::regclass and attname='id' and atttypid='uuid'::regtype and not attisdropped)
     or not exists(select 1 from pg_catalog.pg_attribute
      where attrelid='public.projects'::regclass and attname='org_id' and atttypid='uuid'::regtype and not attisdropped) then
    raise exception 'Workspace child repair requires canonical UUID project parent contracts; repair baseline/history first';
  end if;
  foreach child in array array['chats','tabular_reviews','documents'] loop
    child_oid := ('public.'||child)::regclass;
    if not exists(select 1 from pg_catalog.pg_attribute where attrelid=child_oid and attname='org_id' and atttypid='uuid'::regtype and not attisdropped) then
      raise exception 'Workspace child repair requires %.org_id UUID; repair baseline/history first',child;
    end if;
    select attnum into project_column from pg_catalog.pg_attribute
      where attrelid=child_oid and attname='project_id' and atttypid='uuid'::regtype and not attisdropped;
    if project_column is null or not exists(select 1 from pg_catalog.pg_constraint
        where conrelid=child_oid and confrelid='public.projects'::regclass
          and contype='f' and convalidated and conkey=array[project_column]) then
      raise exception 'Workspace child repair requires validated %.project_id parent FK; repair baseline/history first',child;
    end if;
    if not exists(select 1 from pg_catalog.pg_trigger
        where tgrelid=child_oid and tgname='require_active_organization' and not tgisinternal
          and tgenabled='O' and tgfoid='public.require_active_organization()'::regprocedure
          and (tgtype & 19)=19)
       or not exists(select 1 from pg_catalog.pg_trigger
        where tgrelid=child_oid and tgname=child||'_sync_project_org' and not tgisinternal
          and tgenabled='O' and tgfoid='public.sync_project_child_org_id()'::regprocedure
          and (tgtype & 19)=19) then
      raise exception 'Workspace child repair requires enabled canonical % active-org/sync guards; repair baseline/history first',child;
    end if;
  end loop;
end;
$workspace_repair_contracts$;

alter table public.chats disable trigger require_active_organization;
alter table public.tabular_reviews disable trigger require_active_organization;
alter table public.documents disable trigger require_active_organization;

-- Dev candidate; fresh canonical number after actual preceding source.
-- Migration date: 2026-10-24
--
-- Settings > Privacy & Data now deletes, and exports, one workspace at a
-- time by each row's org_id. A chat, tabular review or document inside a
-- project carries its project's organization: the sync_project_child_org_id
-- triggers set it on insert, and a project's organization never changes
-- afterwards. Re-derive it here anyway, so that a row which somehow
-- disagrees with its project (a manual edit, an unusual install) is filed
-- under the right workspace before a Personal delete or export relies on it.
--
-- Updates only rows that disagree, which on a normal database is none.
-- Safe to re-run.

update public.chats chat
set org_id = project.org_id
from public.projects project
where chat.project_id = project.id
  and chat.org_id is distinct from project.org_id;

update public.tabular_reviews review
set org_id = project.org_id
from public.projects project
where review.project_id = project.id
  and review.org_id is distinct from project.org_id;

update public.documents document
set org_id = project.org_id
from public.projects project
where document.project_id = project.id
  and document.org_id is distinct from project.org_id;

-- Restore each exact guard before the native migration transaction can commit.
alter table public.chats enable trigger require_active_organization;
alter table public.tabular_reviews enable trigger require_active_organization;
alter table public.documents enable trigger require_active_organization;
