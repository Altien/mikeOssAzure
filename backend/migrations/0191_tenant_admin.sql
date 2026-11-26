-- 022: pooled tenant roles, admin read reporting and atomic ownership reassignment.
-- App role values are Mike.Admin / Mike.User; spaced names remain accepted by the adapter.
alter table public.tenants add column enterprise_role_source text not null default 'app_roles'
  check (enterprise_role_source in ('app_roles', 'groups'));
-- Preserve explicitly configured 012 group policies on upgrade.
set role service_role;
update public.tenants t set enterprise_role_source = 'groups'
where exists (select 1 from public.tenant_group_policies p where p.tenant_id = t.tenant_id);
reset role;

alter table public.tenant_memberships
  add column identity_kind text not null default 'altien' check (identity_kind in ('altien', 'enterprise')),
  add column directory_id text,
  add constraint tenant_membership_identity_source check (
    (identity_kind = 'altien' and directory_id is null) or
    (identity_kind = 'enterprise' and directory_id is not null and btrim(directory_id) <> '')
  );
create function public.mirror_enterprise_member(p_tenant_id text, p_user_id text, p_directory_id text, p_role text)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_existing public.tenant_memberships;
begin
  if p_user_id is null or btrim(p_user_id) = '' or p_role is null or p_role not in ('TenantAdmin', 'Member') then
    raise exception using errcode = '22023', message = 'Invalid enterprise membership';
  end if;
  perform 1 from public.tenants where tenant_id = p_tenant_id and status = 'active' for update;
  if not found or not exists (select 1 from public.tenant_identity_sources
    where tid = lower(btrim(p_directory_id)) and tenant_id = p_tenant_id) then
    raise exception using errcode = '23503', message = 'Active tenant directory link not found';
  end if;
  select * into v_existing from public.tenant_memberships where user_id = p_user_id for update;
  if found then
    if v_existing.tenant_id <> p_tenant_id or v_existing.identity_kind <> 'enterprise'
      or v_existing.directory_id <> lower(btrim(p_directory_id)) then
      raise exception using errcode = '23514', message = 'Membership identity source differs';
    end if;
    -- A trusted fresh token, not the observed mirror, is authoritative in Entra.
    if v_existing.role <> p_role then
      update public.tenant_memberships set role = p_role where user_id = p_user_id;
    end if;
  else
    insert into public.tenant_memberships(user_id, tenant_id, role, identity_kind, directory_id)
      values(p_user_id, p_tenant_id, p_role, 'enterprise', lower(btrim(p_directory_id)));
  end if;
end $$;

-- Membership moves preserve the verified identity source; only the role resets.
-- Enterprise directory relinking is separate control-plane orchestration.
create or replace function public.cp_move_member(p_user_id text, p_to_tenant text)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_from text; v_identity text; v_directory text;
begin
  select tenant_id into v_from from public.tenant_memberships where user_id = p_user_id;
  if v_from is null then raise exception using errcode = '23503', message = 'Membership not found'; end if;
  perform 1 from public.tenants where tenant_id in (v_from, p_to_tenant) order by tenant_id for update;
  if not exists (select 1 from public.tenants where tenant_id = p_to_tenant and status = 'active') then
    raise exception using errcode = '23503', message = 'Active destination tenant not found';
  end if;
  select identity_kind, directory_id into v_identity, v_directory from public.tenant_memberships
    where user_id = p_user_id and tenant_id = v_from for update;
  if not found then raise exception using errcode = '40001', message = 'Membership changed; retry'; end if;
  if v_from = p_to_tenant then return; end if;
  -- This retains the existing last-admin guard and session revocation.
  perform public.cp_remove_member(p_user_id);
  insert into public.tenant_memberships(user_id, tenant_id, role, identity_kind, directory_id)
    values(p_user_id, p_to_tenant, 'Member', v_identity, v_directory);
end $$;

create function public.cp_set_member_role(p_user_id text, p_role text)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_tenant text; v_role text; v_identity text;
begin
  if p_role is null or p_role not in ('TenantAdmin', 'Member') then
    raise exception using errcode = '22023', message = 'Invalid tenant role';
  end if;
  select tenant_id into v_tenant from public.tenant_memberships where user_id = p_user_id;
  if v_tenant is null then raise exception using errcode = '23503', message = 'Membership not found'; end if;
  perform 1 from public.tenants where tenant_id = v_tenant for update;
  select role, identity_kind into v_role, v_identity from public.tenant_memberships where user_id = p_user_id and tenant_id = v_tenant for update;
  if not found then raise exception using errcode = '40001', message = 'Membership changed; retry'; end if;
  if v_identity = 'enterprise' then raise exception using errcode = '22023', message = 'Enterprise roles are managed in Entra'; end if;
  if v_role = 'TenantAdmin' and p_role <> 'TenantAdmin'
    and not exists (select 1 from public.tenant_memberships where tenant_id = v_tenant and user_id <> p_user_id and role = 'TenantAdmin') then
    raise exception using errcode = '23514', message = 'Cannot demote the last tenant admin';
  end if;
  update public.tenant_memberships set role = p_role where user_id = p_user_id and tenant_id = v_tenant;
  if v_role <> p_role then perform app.revoke_member_sessions(p_user_id); end if;
end $$;
-- cp_remove_member deliberately retains 0119's sole-member leave exception.
-- It refuses to strand remaining members without an admin, while cp_move_member
-- can move a sole member and leave the source tenant empty for offboarding.
do $$ declare v_had boolean := has_schema_privilege('service_role', 'public', 'CREATE'); begin
  grant create on schema public to service_role;
  alter function public.cp_set_member_role(text,text) owner to service_role;
  alter function public.cp_move_member(text,text) owner to service_role;
  alter function public.mirror_enterprise_member(text,text,text,text) owner to service_role;
  if not v_had then revoke create on schema public from service_role; end if;
end $$;
revoke all on function public.cp_set_member_role(text,text), public.cp_move_member(text,text), public.mirror_enterprise_member(text,text,text,text) from public, web_anon, authenticated, tenant_app;
grant execute on function public.cp_set_member_role(text,text), public.cp_move_member(text,text), public.mirror_enterprise_member(text,text,text,text) to service_role;
-- Extend both existing explicit platform-function gate lists without replacing the gate.
do $$ declare v_definition text; begin
  select pg_get_functiondef('app.tenant_rls_gaps()'::regprocedure) into v_definition;
  execute replace(v_definition, '''cp_add_member'',', '''mirror_enterprise_member'', ''cp_set_member_role'', ''cp_add_member'',');
end $$;

-- The request client signs these roles only AFTER identity/tenant policy admission.
create function app.require_tenant_admin() returns void
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
begin
  if app.current_tenant_id() is null or coalesce(v_claims->>'sub', '') = ''
    or not coalesce(v_claims->'app_roles' @> '["TenantAdmin"]'::jsonb, false) then
    raise exception using errcode = '42501', message = 'Tenant admin required';
  end if;
end $$;
revoke all on function app.require_tenant_admin() from public, web_anon, authenticated;
grant execute on function app.require_tenant_admin() to tenant_app, tenant_definer;

-- Membership tables remain inaccessible through the ordinary table surface.
grant select on public.tenant_memberships to tenant_definer;
-- Row locks require UPDATE on one column; ordinary tenant_app receives no new grant.
grant update(updated_at) on public.tenants to tenant_definer;
grant update(role) on public.tenant_memberships to tenant_definer;
create function public.tenant_admin_members() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform app.require_tenant_admin();
  return (select coalesce(jsonb_agg(jsonb_build_object(
    'userId', m.user_id, 'role', m.role, 'displayName', p.display_name, 'email', p.email)
    order by m.user_id), '[]'::jsonb)
    from public.tenant_memberships m left join public.user_profiles p
      on p.tenant_id = m.tenant_id and p.user_id::text = m.user_id
    where m.tenant_id = app.current_tenant_id());
end $$;

-- Sharing uses this bounded predicate for ordinary admitted members (013).
create function public.tenant_member_exists(p_user_id text) returns boolean
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
begin
  if app.current_tenant_id() is null or coalesce(v_claims->>'sub', '') = ''
    or not coalesce(v_claims->'app_roles' @> '["Member"]'::jsonb, false) then return false; end if;
  return exists (select 1 from public.tenant_memberships m join public.tenants t using(tenant_id)
    where m.tenant_id = app.current_tenant_id() and m.user_id = p_user_id and t.status = 'active');
end $$;

-- Summation stays in SQL: no max-rows truncation and no JS decimal arithmetic.
create function public.tenant_admin_usage() returns jsonb
language plpgsql stable security invoker set search_path = pg_catalog, pg_temp as $$
declare v_month date := date_trunc('month', now() at time zone 'UTC')::date; v_result jsonb;
begin
  perform app.require_tenant_admin();
  with tokens as (
    select user_id, sum(input_tokens + output_tokens) total_tokens
    from public.llm_usage_events where tenant_id = app.current_tenant_id()
      and created_at >= v_month::timestamp at time zone 'UTC'
      and created_at < (v_month + interval '1 month')::timestamp at time zone 'UTC'
    group by user_id
  ), credits as (
    select user_id, sum(credits) total_credits from public.llm_usage_events
    where tenant_id = app.current_tenant_id() and credit_period = v_month group by user_id
  ), ids as (select user_id from tokens union select user_id from credits), users as (
    select ids.user_id, coalesce((select total_tokens from tokens t where t.user_id is not distinct from ids.user_id),0) total_tokens,
      coalesce((select total_credits from credits c where c.user_id is not distinct from ids.user_id),0) total_credits from ids
  )
  select jsonb_build_object('periodStart', v_month,
    'totalTokens', coalesce(sum(total_tokens),0), 'totalCredits', coalesce(sum(total_credits),0)::text,
    'byUser', coalesce(jsonb_agg(jsonb_build_object('userId', user_id,
      'totalTokens', total_tokens, 'totalCredits', total_credits::text) order by user_id), '[]'::jsonb))
    into v_result from users;
  return v_result;
end $$;

create function public.tenant_admin_reassign(p_kind text, p_id uuid, p_new_owner text, p_reason text)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_table text; v_owner text; v_org uuid; v_project uuid; v_kind text; v_actor text;
begin
  perform app.require_tenant_admin();
  v_actor := nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub';
  if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 500 then
    raise exception using errcode = '22023', message = 'A reason between 3 and 500 characters is required';
  end if;
  v_table := case p_kind when 'project' then 'projects' when 'chat' then 'chats' when 'review' then 'tabular_reviews' end;
  if v_table is null then raise exception using errcode = '22023', message = 'Invalid content kind'; end if;
  -- Same tenant row lock as cp_* serialises reassignment against removal/moves.
  perform 1 from public.tenants where tenant_id = app.current_tenant_id() for update;
  perform 1 from public.tenant_memberships where tenant_id = app.current_tenant_id() and user_id = p_new_owner for share;
  if not found then raise exception using errcode = '22023', message = 'The new owner must be a member of this tenant'; end if;
  if p_kind = 'project' then
    select user_id, org_id, project_kind into v_owner, v_org, v_kind from public.projects
      where id = p_id and tenant_id = app.current_tenant_id() for update;
    if not found then raise exception using errcode = 'P0002', message = 'Content not found'; end if;
    if v_kind in ('external_provenance', 'skill_library') then
      raise exception using errcode = '22023', message = 'Shared system libraries cannot be reassigned';
    end if;
  else
    execute format('select user_id, org_id, project_id from public.%I where id = $1 and tenant_id = $2 for update', v_table)
      into v_owner, v_org, v_project using p_id, app.current_tenant_id();
    if v_owner is null and not exists (
      select 1 from public.chats where p_kind = 'chat' and id = p_id and tenant_id = app.current_tenant_id()
      union all select 1 from public.tabular_reviews where p_kind = 'review' and id = p_id and tenant_id = app.current_tenant_id()
    ) then raise exception using errcode = 'P0002', message = 'Content not found'; end if;
    if v_project is not null then
      select org_id, project_kind into v_org, v_kind from public.projects
        where id = v_project and tenant_id = app.current_tenant_id() for share;
      if not found then raise exception using errcode = 'P0002', message = 'Parent project not found'; end if;
      if v_kind in ('external_provenance', 'skill_library') then
        raise exception using errcode = '22023', message = 'Shared system library content cannot be reassigned';
      end if;
    end if;
  end if;
  if v_org is not null and not exists (select 1 from public.org_members
    where org_id = v_org and user_id::text = p_new_owner and tenant_id = app.current_tenant_id()) then
    raise exception using errcode = '22023', message = 'The new owner must also be a member of this content organisation';
  end if;
  execute format('update public.%I set user_id = $1 where id = $2 and tenant_id = $3', v_table)
    using p_new_owner, p_id, app.current_tenant_id();
  -- The mutation and its audit commit or roll back together.
  insert into public.audit_events(user_id, action, surface, project_id, chat_id, review_id, detail)
    values(v_actor, 'tenant_admin.owner_reassigned', 'organisation',
      case when p_kind = 'project' then p_id else v_project end,
      case when p_kind = 'chat' then p_id end, case when p_kind = 'review' then p_id end,
      jsonb_build_object('actor', v_actor, 'owner', v_owner, 'newOwner', p_new_owner,
        'object', jsonb_build_object('kind', p_kind, 'id', p_id), 'reason', btrim(p_reason)));
end $$;

do $$ declare v_had boolean := has_schema_privilege('tenant_definer', 'public', 'CREATE'); begin
  grant create on schema public to tenant_definer;
  alter function public.tenant_admin_members() owner to tenant_definer;
  alter function public.tenant_member_exists(text) owner to tenant_definer;
  alter function public.tenant_admin_reassign(text,uuid,text,text) owner to tenant_definer;
  if not v_had then revoke create on schema public from tenant_definer; end if;
end $$;
revoke all on function public.tenant_member_exists(text), public.tenant_admin_members(), public.tenant_admin_usage(),
  public.tenant_admin_reassign(text,uuid,text,text) from public, web_anon, authenticated;
grant execute on function public.tenant_member_exists(text), public.tenant_admin_members(), public.tenant_admin_usage(),
  public.tenant_admin_reassign(text,uuid,text,text) to tenant_app, service_role;

do $$ declare v_gaps text; begin
  select string_agg(object || ': ' || problem, '; ') into v_gaps from app.tenant_rls_gaps();
  if v_gaps is not null then raise exception 'multi-tenant 022: tenant RLS gaps: %', v_gaps; end if;
end $$;
notify pgrst, 'reload schema';
