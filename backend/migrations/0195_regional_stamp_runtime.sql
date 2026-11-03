-- 019: deployment-owned stamp metadata, read by API/worker startup in both modes.
alter table app.install_tenancy
  add column stamp_id text,
  add column region text,
  add constraint install_tenancy_stamp_id_check
    check (stamp_id is null or stamp_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$'),
  add constraint install_tenancy_region_check
    check (region is null or region ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  add constraint install_tenancy_pooled_fallback_check
    check (not pooled or fallback_tenant_id is null);

-- Runtime cannot change mode or stamp identity. The existing single-install
-- adoption trigger still needs these two column privileges for its first row.
revoke update on app.install_tenancy from service_role;
grant update(fallback_tenant_id, updated_at) on app.install_tenancy to service_role;

create function public.stamp_runtime_metadata() returns jsonb
language sql stable security invoker set search_path=pg_catalog,pg_temp as $$
  select jsonb_build_object(
    'pooled', pooled,
    'fallback_tenant_id', fallback_tenant_id,
    'stamp_id', stamp_id,
    'region', region,
    'platform_credentials', (
      select coalesce(jsonb_agg(distinct jsonb_build_object('tier', s.tier, 'provider', p.provider, 'model', p.model)), '[]'::jsonb)
        from public.tenant_settings s
        join public.tenants t on t.tenant_id=s.tenant_id and t.status='active'
        join public.tenant_budgets b on b.tenant_id=s.tenant_id
        join app.credit_prices p on p.version=b.price_version
       where s.key_mode='platform' and (s.model_allowlist is null or p.model=any(s.model_allowlist))
    )
  ) from app.install_tenancy where singleton
$$;
revoke all on function public.stamp_runtime_metadata()
  from public, web_anon, authenticated, tenant_app, control_plane;
grant execute on function public.stamp_runtime_metadata() to service_role;

do $$
begin
  if exists(select 1 from app.tenant_rls_gaps()) then
    raise exception 'multi-tenant 019: tenant RLS gate failed';
  end if;
end $$;
notify pgrst, 'reload schema';
