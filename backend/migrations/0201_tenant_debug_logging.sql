-- Per-tenant debug logging switch (docs/structured-logging.md). The control
-- plane turns debug-level log records on for one tenant until an end time;
-- Mike polls the column every 30 s and enforces the end itself. Any tenant
-- status is accepted, so a suspended or offboarding tenant can be diagnosed.
-- Not tenant metadata: updated_at is not touched. No RLS change: the column is
-- read only by the platform role, and control_plane gets no table privilege.
alter table public.tenants add column debug_log_until timestamptz;

-- On for p_minutes from now (not additive); returns the end time.
create function public.cp_set_tenant_debug(p_tenant_id text, p_minutes integer default 120)
returns timestamptz language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_until timestamptz;
begin
  if p_minutes is null or p_minutes < 1 or p_minutes > 1440 then
    raise exception using errcode = '22023', message = 'Debug duration must be 1 to 1440 minutes';
  end if;
  update public.tenants set debug_log_until = now() + make_interval(mins => p_minutes)
    where tenant_id = p_tenant_id returning debug_log_until into v_until;
  if not found then raise exception using errcode = '23503', message = 'Tenant not found'; end if;
  return v_until;
end $$;

-- Off. Idempotent for an existing tenant.
create function public.cp_clear_tenant_debug(p_tenant_id text)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  update public.tenants set debug_log_until = null where tenant_id = p_tenant_id;
  if not found then raise exception using errcode = '23503', message = 'Tenant not found'; end if;
end $$;

do $$ declare v_had boolean := has_schema_privilege('service_role', 'public', 'CREATE'); begin
  grant create on schema public to service_role;
  alter function public.cp_set_tenant_debug(text,integer) owner to service_role;
  alter function public.cp_clear_tenant_debug(text) owner to service_role;
  if not v_had then revoke create on schema public from service_role; end if;
end $$;
revoke all on function public.cp_set_tenant_debug(text,integer), public.cp_clear_tenant_debug(text)
  from public, web_anon, authenticated, tenant_app, control_plane;
grant execute on function public.cp_set_tenant_debug(text,integer), public.cp_clear_tenant_debug(text)
  to service_role, control_plane;

-- Extend both platform-function lists and the control_plane executable set.
-- The control_plane anchor is the array's FIRST element, which no concurrent
-- migration that appends a function moves.
do $$ declare v_old text; v_new text; begin
  select pg_get_functiondef('app.tenant_rls_gaps()'::regprocedure) into v_old;
  v_new := replace(v_old, '''cp_add_member'',', '''cp_set_tenant_debug'', ''cp_clear_tenant_debug'', ''cp_add_member'',');
  if v_new = v_old then raise exception 'anchor not found'; end if;
  execute v_new;
  select pg_get_functiondef('app.control_plane_gaps()'::regprocedure) into v_old;
  v_new := replace(v_old, '''public.cp_upsert_tenant(text,text,text,text)''::regprocedure,',
    '''public.cp_set_tenant_debug(text,integer)''::regprocedure,''public.cp_clear_tenant_debug(text)''::regprocedure,''public.cp_upsert_tenant(text,text,text,text)''::regprocedure,');
  if v_new = v_old then raise exception 'anchor not found'; end if;
  execute v_new;
end $$;

do $$ declare v_gaps text; begin
  select string_agg(object || ': ' || problem, '; ') into v_gaps
    from (select * from app.tenant_rls_gaps() union all select * from app.control_plane_gaps()) g;
  if v_gaps is not null then raise exception 'tenant debug logging: %', v_gaps; end if;
end $$;
notify pgrst, 'reload schema';
