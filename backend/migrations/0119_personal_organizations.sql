-- Dev numbered adaptation of 3ca82155cd3ebc8f2b94215bcca178d79c808f12
-- Canonical runner supplies the file transaction. Profile erasure owns cascade.
-- Migration date: 2026-10-12
--
-- Personal organizations (stage 1 of making an organization mandatory).
--
-- Until now personal work was simply work with no organization. Every
-- person now has an organization of their own: an ordinary row in
-- organizations, of kind 'personal', which they alone belong to, as its
-- owner. It is behind the scenes: it is not listed among a person's
-- organizations, cannot be renamed, joined, left or deleted on its own, and
-- to its owner it is still "Personal".
--
-- This stage only brings them into existence, for existing accounts and at
-- sign-up. No work moves into them yet; that, and making org_id mandatory,
-- are the stages that follow.
--
--   organizations.kind              'team' (every existing organization) or
--                                   'personal'
--   organizations.personal_user_id  whose it is; set exactly when personal
--   ensure_personal_organization()  create-if-missing, returning its id
--
-- Safe to re-run: add column / create index if not exists, create or
-- replace, drop-before-create for constraints and triggers, and a backfill
-- that only creates what is missing.

alter table public.organizations
  add column if not exists kind text not null default 'team';

alter table public.organizations
  drop constraint if exists organizations_kind_check;
alter table public.organizations
  add constraint organizations_kind_check
  check (kind in ('team', 'personal'));

-- Deleting the account takes its personal organization with it.
alter table public.organizations
  add column if not exists personal_user_id uuid
  references public.user_profiles(user_id) on delete cascade;

alter table public.organizations
  drop constraint if exists organizations_personal_owner_check;
alter table public.organizations
  add constraint organizations_personal_owner_check
  check ((kind = 'personal') = (personal_user_id is not null));

-- One personal organization per person.
create unique index if not exists organizations_personal_user_key
  on public.organizations(personal_user_id)
  where personal_user_id is not null;

-- A personal organization has exactly one member: its owner, as owner. This
-- is what "personal" means, so it is held here rather than left to callers.
create or replace function public.org_members_guard_personal()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare owner_id uuid;
begin
  select o.personal_user_id into owner_id
  from public.organizations o
  where o.id = new.org_id and o.kind = 'personal';
  if not found then
    return new;
  end if;
  if new.user_id is distinct from owner_id or new.role <> 'owner' then
    raise exception 'A personal organization belongs to one person only'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists org_members_personal_guard on public.org_members;
create trigger org_members_personal_guard
  before insert or update on public.org_members
  for each row execute procedure public.org_members_guard_personal();

-- Nobody is invited into one either.
create or replace function public.org_invitations_guard_personal()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.organizations o
    where o.id = new.org_id and o.kind = 'personal'
  ) then
    raise exception 'A personal organization cannot have invitations'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists org_invitations_personal_guard on public.org_invitations;
create trigger org_invitations_personal_guard
  before insert or update of org_id on public.org_invitations
  for each row execute procedure public.org_invitations_guard_personal();

-- Create a person's personal organization if they do not have one, and
-- return its id either way. Safe to call any number of times, and from two
-- sessions at once: the unique index decides, and the loser reads the
-- winner's row.
create or replace function public.ensure_personal_organization(p_user_id text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare org uuid;
declare principal_id uuid;
begin
  -- Supported provider principals are UUID-backed in Dev profiles/memberships.
  -- Resolve the external TEXT RPC identity against the profile, never its id.
  select profile.user_id into principal_id
  from public.user_profiles profile
  where profile.user_id::text = p_user_id
  for key share;
  if not found then
    raise exception 'User profile not found' using errcode = '23503';
  end if;
  select o.id into org from public.organizations o
  where o.personal_user_id = principal_id;
  if org is null then
    insert into public.organizations (name, created_by, kind, personal_user_id)
    values ('Personal', principal_id, 'personal', principal_id)
    on conflict (personal_user_id) where personal_user_id is not null
    do nothing
    returning id into org;
    if org is null then
      select o.id into org from public.organizations o
      where o.personal_user_id = principal_id;
    end if;
  end if;
  insert into public.org_members (org_id, user_id, role)
  values (org, principal_id, 'owner')
  on conflict (org_id, user_id) do nothing;
  return org;
end;
$$;

-- Dev initialization uses middleware/auth.ts after upsertUserProfile; no
-- provider-owned auth-schema trigger is installed. See manifest integration.

-- Existing accounts.
do $$
declare account record;
begin
  for account in
    select u.user_id from public.user_profiles u
    where not exists (
      select 1 from public.organizations o where o.personal_user_id = u.user_id
    )
  loop
    perform public.ensure_personal_organization(account.user_id::text);
  end loop;
end $$;

revoke all on function public.ensure_personal_organization(text)
  from public, web_anon, authenticated;
revoke all on function public.org_members_guard_personal()
  from public, web_anon, authenticated;
revoke all on function public.org_invitations_guard_personal()
  from public, web_anon, authenticated;
grant execute on function public.ensure_personal_organization(text) to service_role;

-- Private PostgREST: these RPCs/triggers are backend service-role only.
do $privileges$
declare f record;
begin
  for f in
    select p.oid::regprocedure::text as signature
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any (array['org_members_guard_personal', 'org_invitations_guard_personal', 'ensure_personal_organization']::text[])
  loop
    execute format('revoke all on function %s from public, web_anon, authenticated', f.signature);
    execute format('grant execute on function %s to service_role', f.signature);
  end loop;
end;
$privileges$;

notify pgrst, 'reload schema';
