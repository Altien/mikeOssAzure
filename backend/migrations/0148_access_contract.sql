-- Dev candidate for source161 c1f8258b31b4f77bc2967032257aecf16b907bfc.
-- Upstream dated source: backend/migrations/20261017_04_playbook_access.sql
-- Staging order 07; allocate a fresh canonical number after actual Dev160.
-- Native migration runner owns the transaction. Foundation only; full unit needs165/180.

-- Verify the old email-list representation was copied before removing it.
do $playbook_shares_backfill_required$
begin
  if exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='playbooks' and column_name='shared_with') then
    if exists(
      select 1 from public.playbooks b cross join unnest(b.shared_with) recipient(email)
      where b.org_id is null and trim(recipient.email)<>'' and not exists(
        select 1 from public.playbook_shares s where s.playbook_id=b.id
          and s.shared_with_email=lower(trim(recipient.email))
      )
    ) then
      raise exception 'Playbook email shares must be backfilled before contracting shared_with';
    end if;
  end if;
end;
$playbook_shares_backfill_required$;

alter table public.playbooks drop constraint if exists playbooks_visibility_check;
drop index if exists public.idx_playbooks_shared_with;
alter table public.playbooks drop column if exists shared_with;
alter table public.playbooks add constraint playbooks_visibility_check
  check (visibility in ('private', 'organization') and
    (org_id is not null or visibility = 'private'));

-- Reconciled with actual Dev160: preserve 0126 resource/archive/member cases,
-- 0117 public-only owner promotion cleanup, and canonical active-org semantics.
-- New playbook owner/actor values are TEXT; override member keys remain UUID.
create or replace function public.validate_org_access_override()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare resource_org_id uuid;
declare resource_creator_id text;
declare resource_visibility text;
declare member_role text;
declare archived timestamptz;
begin
  case tg_table_name
    when 'project_org_access_overrides' then
      select p.org_id, p.user_id, p.visibility, p.archived_at
        into resource_org_id, resource_creator_id, resource_visibility, archived
      from public.projects p where p.id = new.project_id for update;
    when 'workflow_org_access_overrides' then
      select w.org_id, w.user_id, w.visibility, w.archived_at
        into resource_org_id, resource_creator_id, resource_visibility, archived
      from public.workflows w where w.id = new.workflow_id for update;
    when 'playbook_org_access_overrides' then
      -- Playbooks are never archived.
      select b.org_id, b.user_id, b.visibility, null::timestamptz
        into resource_org_id, resource_creator_id, resource_visibility, archived
      from public.playbooks b where b.id = new.playbook_id for update;
    else
      raise exception 'Unsupported organization override table';
  end case;

  -- Dev: retained membership rows in a soft-deleted organization are not
  -- authority to write new grants. Reuse the canonical lifecycle predicate.
  if not public.org_is_active(resource_org_id) then
    raise exception 'Organization is unavailable' using errcode='23514';
  end if;
  if archived is not null then
    raise exception 'Archived work must be restored by an organization owner' using errcode='23514';
  end if;
  if resource_org_id is null or resource_org_id is distinct from new.org_id then
    raise exception 'Organization override does not match the resource organization'
      using errcode = '23514';
  end if;
  if resource_creator_id = new.user_id::text then
    raise exception 'The creator is always an owner'
      using errcode = '23514';
  end if;
  select m.role into member_role
  from public.org_members m
  where m.org_id = new.org_id and m.user_id = new.user_id
  for key share;
  if not found then
    raise exception 'Organization access overrides require active membership'
      using errcode = '23514';
  end if;
  -- An organization owner owns every public item, so there is nothing to
  -- give or deny them there. A private item is not theirs unless shared, so
  -- there they are given a role like any other member.
  if member_role = 'owner' and resource_visibility = 'organization' then
    raise exception 'Organization owners always own a public item'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists playbook_org_access_overrides_guard
  on public.playbook_org_access_overrides;
create trigger playbook_org_access_overrides_guard before insert or update
  on public.playbook_org_access_overrides for each row
  execute procedure public.validate_org_access_override();

create or replace function public.cleanup_org_admin_access_overrides()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.role = 'owner' then
    delete from public.project_org_access_overrides o
    using public.projects p
    where o.org_id = new.org_id and o.user_id = new.user_id
      and p.id = o.project_id and p.visibility = 'organization';
    delete from public.workflow_org_access_overrides o
    using public.workflows w
    where o.org_id = new.org_id and o.user_id = new.user_id
      and w.id = o.workflow_id and w.visibility = 'organization';
    delete from public.playbook_org_access_overrides o
    using public.playbooks b
    where o.org_id = new.org_id and o.user_id = new.user_id
      and b.id = o.playbook_id and b.visibility = 'organization';
  end if;
  return new;
end;
$$;

revoke all privileges on table public.playbook_shares,
  public.playbook_org_access_overrides from public, web_anon, authenticated;
grant select, insert, update, delete on public.playbook_shares,
  public.playbook_org_access_overrides to service_role;

revoke all on function public.validate_org_access_override(),
  public.cleanup_org_admin_access_overrides() from public, web_anon, authenticated;
grant execute on function public.validate_org_access_override(),
  public.cleanup_org_admin_access_overrides() to service_role;

notify pgrst, 'reload schema';
