-- Multi-tenant 021: one membership per identity, enterprise directory links,
-- session revocation on membership changes and immutable content tenancy.
create table public.tenant_memberships (
  user_id text primary key check (btrim(user_id) <> ''),
  tenant_id text not null default app.tenant_id_default() references public.tenants(tenant_id),
  role text not null default 'Member' check (role in ('TenantAdmin', 'Member')),
  joined_at timestamptz not null default now()
);
create index tenant_memberships_tenant_idx on public.tenant_memberships(tenant_id, user_id);
create table public.tenant_identity_sources (
  tid text primary key check (btrim(tid) <> ''),
  tenant_id text not null default app.tenant_id_default() references public.tenants(tenant_id),
  linked_at timestamptz not null default now()
);
create index tenant_identity_sources_tenant_idx on public.tenant_identity_sources(tenant_id);
select app.enable_tenant_rls('public.tenant_memberships');
select app.enable_tenant_rls('public.tenant_identity_sources');
-- These are resolver/control-plane records, never the tenant request surface.
revoke all on public.tenant_memberships, public.tenant_identity_sources
  from public, web_anon, authenticated, tenant_app;
grant select, insert, update, delete on public.tenant_memberships, public.tenant_identity_sources to service_role;

create or replace function app.reject_tenant_id_change()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if new.tenant_id is distinct from old.tenant_id then
    raise exception using errcode = '23514', message = 'tenant_id is immutable';
  end if;
  return new;
end $$;
revoke all on function app.reject_tenant_id_change() from public, web_anon, authenticated;

-- Installing RLS on a new tenant table also installs the immutability guard.
create or replace function app.enable_tenant_rls(p_table regclass)
returns void language plpgsql set search_path = pg_catalog, pg_temp as $$
declare v_rel regclass;
begin
  if not exists (select 1 from pg_attribute where attrelid = p_table and attname = 'tenant_id' and not attisdropped) then
    raise exception 'multi-tenant: % has no tenant_id column', p_table;
  end if;
  for v_rel in select rel from (select p_table as rel, 0 as depth union select t.relid, t.level from pg_partition_tree(p_table) t) parts order by depth loop
    execute format('alter table %s enable row level security', v_rel);
    execute format('alter table %s force row level security', v_rel);
    if exists (select 1 from pg_policy where polrelid = v_rel and polname = 'tenant_isolation') then
      execute format('drop policy tenant_isolation on %s', v_rel);
    end if;
    execute format('create policy tenant_isolation on %s using (tenant_id = (select app.current_tenant_id())) with check (tenant_id = (select app.current_tenant_id()))', v_rel);
    -- Partition children inherit their parent's row trigger automatically.
    if not exists (select 1 from pg_trigger where tgrelid = v_rel and tgname = 'tenant_id_immutable' and not tgisinternal) then
      execute format('create trigger tenant_id_immutable before update of tenant_id on %s for each row execute function app.reject_tenant_id_change()', v_rel);
    end if;
  end loop;
end $$;
revoke all on function app.enable_tenant_rls(regclass) from public, web_anon, authenticated;
do $$ declare r record; begin
  for r in select c.oid::regclass tbl from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relispartition
  loop perform app.enable_tenant_rls(r.tbl); end loop;
end $$;

-- Revoke both browser sessions and unused Word handoff tickets. Incrementing
-- version and clearing the lease prevents an in-flight refresh reviving one.
create or replace function app.revoke_member_sessions(p_user_id text)
returns void language sql set search_path = pg_catalog, pg_temp as $$
  update public.auth_sessions set revoked_at = coalesce(revoked_at, now()),
    version = version + 1, refresh_owner = null, refresh_lease_until = null
    where user_id = p_user_id and revoked_at is null;
  update public.auth_handoff_tickets set consumed_at = coalesce(consumed_at, now())
    where user_id = p_user_id and consumed_at is null;
$$;
revoke all on function app.revoke_member_sessions(text) from public, web_anon, authenticated, tenant_app;
grant execute on function app.revoke_member_sessions(text) to service_role;

create or replace function public.cp_add_member(p_tenant_id text, p_user_id text, p_role text default 'Member')
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform 1 from public.tenants where tenant_id = p_tenant_id for update;
  if not found then raise exception using errcode = '23503', message = 'Tenant not found'; end if;
  insert into public.tenant_memberships(user_id, tenant_id, role) values(p_user_id, p_tenant_id, p_role);
  perform app.revoke_member_sessions(p_user_id);
end $$;
create or replace function public.cp_remove_member(p_user_id text)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_tenant text; v_role text;
begin
  select tenant_id into v_tenant from public.tenant_memberships where user_id = p_user_id;
  if v_tenant is null then return; end if;
  -- Tenant row lock serialises all member mutations, including the last-admin guard.
  perform 1 from public.tenants where tenant_id = v_tenant for update;
  select role into v_role from public.tenant_memberships where user_id = p_user_id and tenant_id = v_tenant for update;
  if not found then raise exception using errcode = '40001', message = 'Membership changed; retry'; end if;
  if v_role = 'TenantAdmin' and exists (select 1 from public.tenant_memberships where tenant_id = v_tenant and user_id <> p_user_id)
    and not exists (select 1 from public.tenant_memberships where tenant_id = v_tenant and user_id <> p_user_id and role = 'TenantAdmin') then
    raise exception using errcode = '23514', message = 'Cannot remove the last tenant admin';
  end if;
  delete from public.tenant_memberships where user_id = p_user_id;
  perform app.revoke_member_sessions(p_user_id);
end $$;
create or replace function public.cp_move_member(p_user_id text, p_to_tenant text)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_from text;
begin
  select tenant_id into v_from from public.tenant_memberships where user_id = p_user_id;
  if v_from is null then raise exception using errcode = '23503', message = 'Membership not found'; end if;
  -- Deterministic order prevents opposing moves deadlocking.
  perform 1 from public.tenants where tenant_id in (v_from, p_to_tenant) order by tenant_id for update;
  if not exists (select 1 from public.tenants where tenant_id = p_to_tenant and status = 'active') then
    raise exception using errcode = '23503', message = 'Active destination tenant not found';
  end if;
  if not exists (select 1 from public.tenant_memberships where user_id = p_user_id and tenant_id = v_from) then
    raise exception using errcode = '40001', message = 'Membership changed; retry';
  end if;
  if v_from = p_to_tenant then return; end if;
  perform public.cp_remove_member(p_user_id);
  -- Start fresh, always as a member. Content and billing stay in the old tenant.
  insert into public.tenant_memberships(user_id, tenant_id, role) values(p_user_id, p_to_tenant, 'Member');
end $$;
create or replace function public.cp_link_identity_source(p_tid text, p_tenant_id text)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  insert into public.tenant_identity_sources(tid, tenant_id) values(lower(btrim(p_tid)), p_tenant_id);
end $$;
create or replace function public.cp_unlink_identity_source(p_tid text)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  delete from public.tenant_identity_sources where tid = lower(btrim(p_tid));
end $$;
-- ALTER OWNER requires temporary CREATE, and service_role keeps no schema DDL.
do $$ declare v_had boolean := has_schema_privilege('service_role', 'public', 'CREATE'); begin
  grant create on schema public to service_role;
  alter function public.cp_add_member(text,text,text) owner to service_role;
  alter function public.cp_remove_member(text) owner to service_role;
  alter function public.cp_move_member(text,text) owner to service_role;
  alter function public.cp_link_identity_source(text,text) owner to service_role;
  alter function public.cp_unlink_identity_source(text) owner to service_role;
  if not v_had then revoke create on schema public from service_role; end if;
end $$;
revoke all on function public.cp_add_member(text,text,text), public.cp_remove_member(text),
  public.cp_move_member(text,text), public.cp_link_identity_source(text,text), public.cp_unlink_identity_source(text)
  from public, web_anon, authenticated, tenant_app;
grant execute on function public.cp_add_member(text,text,text), public.cp_remove_member(text),
  public.cp_move_member(text,text), public.cp_link_identity_source(text,text), public.cp_unlink_identity_source(text)
  to service_role;

-- Explicit platform-function allowlist and immutable-tenancy migration gate.
create or replace function app.tenant_rls_gaps()
returns table (object text, problem text)
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select c.oid::regclass::text,
         case
           when a.attname is null then 'no tenant_id column'
           when not c.relrowsecurity then 'row level security is not enabled'
           when not c.relforcerowsecurity then 'row level security is not forced'
           else 'no tenant_isolation policy'
         end
    from pg_class c
    left join pg_attribute a
      on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
   where c.relnamespace = 'public'::regnamespace
     and c.relkind in ('r', 'p')
     and c.relname <> all (array[
       'courtlistener_citation_index', 'courtlistener_opinion_cluster_index',
       'mike_workflows', 'mike_workflow_assets', 'workflow_addons',
       'workflow_addon_reference_files',
       'pgmigrations', 'organization_backfill_markers', 'auth_oauth_states',
       'stream_run_nodes'
     ])
     and (
       a.attname is null
       or not c.relrowsecurity
       or not c.relforcerowsecurity
       or not exists (
         select 1 from pg_policy p
          where p.polrelid = c.oid and p.polname = 'tenant_isolation'
       )
     )
  union all
  select r.rolname::text, 'role must be nologin, nosuperuser and nobypassrls'
    from pg_roles r
   where r.rolname = 'tenant_app'
     and (r.rolsuper or r.rolbypassrls or r.rolcanlogin)
  union all
  select p.oid::regprocedure::text,
         'tenant_app may execute a platform or job-control function'
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname = any (array[
       'cp_add_member', 'cp_remove_member', 'cp_move_member',
       'cp_link_identity_source', 'cp_unlink_identity_source',
       'claim_upload_processing_job', 'expire_exhausted_upload_jobs',
       'replace_mike_workflows', 'document_lifecycle_version',
       'consume_auth_oauth_state', 'consume_auth_handoff',
       'claim_auth_session_refresh', 'finish_auth_session_refresh',
       'revoke_auth_session',
       'claim_db_job', 'claim_db_jobs', 'renew_db_job', 'finish_db_job', 'defer_db_job'
     ])
     and exists (select 1 from pg_roles where rolname = 'tenant_app')
     and has_function_privilege('tenant_app', p.oid, 'execute')
  union all
  select p.oid::regprocedure::text,
         'security definer function owned by an RLS-bypassing role'
    from pg_proc p
    join pg_roles o on o.oid = p.proowner
   where p.pronamespace in ('public'::regnamespace, 'app'::regnamespace)
     and p.prosecdef
     and (o.rolsuper or o.rolbypassrls)
     and p.proname <> all (array[
       'cp_add_member', 'cp_remove_member', 'cp_move_member',
       'cp_link_identity_source', 'cp_unlink_identity_source',
       'claim_upload_processing_job', 'expire_exhausted_upload_jobs',
       'replace_mike_workflows', 'document_lifecycle_version',
       'consume_auth_oauth_state', 'consume_auth_handoff',
       'claim_auth_session_refresh', 'finish_auth_session_refresh',
       'revoke_auth_session', 'adopt_install_tenant'
     ])
  union all
  select c.oid::regclass::text, 'no tenant_id immutability trigger'
    from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
     and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'tenant_id_immutable' and not t.tgisinternal)
   order by 1
$$;
revoke all on function app.tenant_rls_gaps() from public;
grant execute on function app.tenant_rls_gaps() to service_role;

do $$
declare
  v_gaps text;
begin
  select string_agg(object || ': ' || problem, '; ') into v_gaps from app.tenant_rls_gaps();
  if v_gaps is not null then
    raise exception 'multi-tenant 008: tenant RLS gaps: %', v_gaps;
  end if;
end $$;


notify pgrst, 'reload schema';
