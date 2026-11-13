-- Named Microsoft members: the control plane admits one exact Microsoft person
-- (verified directory ID + object ID), work or personal account. These rows
-- use identity_kind 'microsoft' and grant admission and a role. Rows written
-- by mirror_enterprise_member keep identity_kind 'enterprise': auth metadata
-- only, never matched by the resolver as a named membership.
alter table public.tenant_memberships
  drop constraint tenant_memberships_identity_kind_check,
  drop constraint tenant_membership_identity_source,
  add constraint tenant_memberships_identity_kind_check check (identity_kind in ('altien', 'enterprise', 'microsoft')),
  add constraint tenant_membership_identity_source check (
    (identity_kind = 'altien' and directory_id is null) or
    (identity_kind in ('enterprise', 'microsoft') and directory_id is not null and btrim(directory_id) <> '')
  );

-- user_id is the token's oid, the same principal.userId every other row uses.
-- The directory ID is normalised like tenant_identity_sources.tid.
create function public.cp_add_directory_member(p_tenant_id text, p_directory_id text, p_object_id text, p_role text default 'Member')
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_directory text := lower(btrim(p_directory_id));
  v_user text := lower(btrim(p_object_id));
  v_guid constant text := '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$';
begin
  if not coalesce(v_directory ~ v_guid and v_user ~ v_guid and p_role in ('TenantAdmin', 'Member'), false) then
    raise exception using errcode = '22023', message = 'Invalid directory member';
  end if;
  perform 1 from public.tenants where tenant_id = p_tenant_id for update;
  if not found then raise exception using errcode = '23503', message = 'Tenant not found'; end if;
  -- An existing membership for this person, of any kind, is a unique_violation (23505).
  insert into public.tenant_memberships(user_id, tenant_id, role, identity_kind, directory_id)
    values(v_user, p_tenant_id, p_role, 'microsoft', v_directory);
  perform app.revoke_member_sessions(v_user);
end $$;

-- Personal Microsoft accounts are admitted only by a named membership, so the
-- consumers directory can never be linked as an organisation.
create or replace function public.cp_link_identity_source(p_tid text, p_tenant_id text)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if lower(btrim(p_tid)) = '9188040d-6c67-4c5b-b112-36a304b66dad' then
    raise exception using errcode = '22023', message = 'Personal Microsoft accounts cannot be linked as a directory';
  end if;
  insert into public.tenant_identity_sources(tid, tenant_id) values(lower(btrim(p_tid)), p_tenant_id);
end $$;

do $$ declare v_had boolean := has_schema_privilege('service_role', 'public', 'CREATE'); begin
  grant create on schema public to service_role;
  alter function public.cp_add_directory_member(text,text,text,text) owner to service_role;
  if not v_had then revoke create on schema public from service_role; end if;
end $$;
-- CREATE OR REPLACE preserves cp_link_identity_source's owner; restate its exact grants.
revoke all on function public.cp_add_directory_member(text,text,text,text), public.cp_link_identity_source(text,text)
  from public, web_anon, authenticated, tenant_app, control_plane;
grant execute on function public.cp_add_directory_member(text,text,text,text), public.cp_link_identity_source(text,text)
  to service_role, control_plane;

-- Extend both platform-function lists and the control_plane executable set.
do $$ declare v_definition text; begin
  select pg_get_functiondef('app.tenant_rls_gaps()'::regprocedure) into v_definition;
  execute replace(v_definition, '''cp_add_member'',', '''cp_add_directory_member'', ''cp_add_member'',');
  select pg_get_functiondef('app.control_plane_gaps()'::regprocedure) into v_definition;
  execute replace(v_definition, '''public.cp_unlink_identity_source(text)''::regprocedure]',
    '''public.cp_unlink_identity_source(text)''::regprocedure,''public.cp_add_directory_member(text,text,text,text)''::regprocedure]');
end $$;

do $$ declare v_gaps text; begin
  select string_agg(object || ': ' || problem, '; ') into v_gaps
    from (select * from app.tenant_rls_gaps() union all select * from app.control_plane_gaps()) g;
  if v_gaps is not null then raise exception 'named microsoft members: %', v_gaps; end if;
end $$;
notify pgrst, 'reload schema';
