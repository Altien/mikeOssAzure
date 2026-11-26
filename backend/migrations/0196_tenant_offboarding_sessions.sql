-- A real-cookie offboarding smoke found that0127's write fence also
-- blocks session revocation after status becomes offboarding. Revoke while
-- holding the same tenant lock, then flip status and enqueue atomically.
create or replace function public.cp_set_tenant_status(p_tenant_id text,p_status text)
returns void language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare v_status text;
begin
  if p_status is null or p_status not in ('active','suspended','offboarding') then
    raise exception using errcode='22023',message='Invalid tenant status';
  end if;
  select status into v_status from public.tenants where tenant_id=p_tenant_id for update;
  if not found then raise exception using errcode='23503',message='Tenant not found'; end if;
  if v_status='offboarding' and p_status<>'offboarding' then
    raise exception using errcode='23514',message='Offboarding cannot be reversed';
  end if;
  if p_status<>'active' then
    update public.auth_sessions set revoked_at=coalesce(revoked_at,now()),version=version+1,
      refresh_owner=null,refresh_lease_until=null where tenant_id=p_tenant_id and revoked_at is null;
    update public.auth_handoff_tickets set consumed_at=coalesce(consumed_at,now())
      where tenant_id=p_tenant_id and consumed_at is null;
  end if;
  update public.tenants set status=p_status,updated_at=now() where tenant_id=p_tenant_id;
  if p_status='offboarding' and not exists(select 1 from public.tenants where tenant_id=p_tenant_id and purged_at is not null) then
    insert into public.db_jobs(tenant_id,kind,payload,dedupe_key,max_attempts)
      values(p_tenant_id,'tenant.purge','{}'::jsonb,'tenant.purge',20)
      on conflict (tenant_id,dedupe_key) where dedupe_key is not null and status in ('pending','running')
      do nothing;
  end if;
end $$;

-- CREATE OR REPLACE preserves0127's service_role owner and exact grants.
revoke all on function public.cp_set_tenant_status(text,text)
  from public,web_anon,authenticated,tenant_app;
grant execute on function public.cp_set_tenant_status(text,text) to service_role,control_plane;
do $$ declare v_gaps text; begin
  select string_agg(object || ': ' || problem,'; ') into v_gaps from app.tenant_rls_gaps();
  if v_gaps is not null then raise exception 'multi-tenant019: %',v_gaps; end if;
end $$;
notify pgrst,'reload schema';
