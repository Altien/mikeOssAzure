-- Hybrid key mode and member keys (docs/multi-tenant/control-plane-contract.md).
-- hybrid: a provider with a tenant secret reference runs on the tenant's key,
-- any other provider on the platform's key. member_key_models lists the models
-- (exact application model IDs, as model_allowlist) for which a member may use
-- their own provider key; NULL or an empty array permits none. Same signature,
-- owner and grants for cp_set_entitlements, so no gate list changes.
alter table public.tenant_settings
  drop constraint tenant_settings_key_mode_check,
  add constraint tenant_settings_key_mode_check check (key_mode in ('platform', 'byo', 'hybrid')),
  add column member_key_models text[];
comment on column public.tenant_settings.member_key_models is 'Models for which a member may use their own provider key; NULL or empty permits none. Exact application model IDs, as model_allowlist.';

create or replace function public.cp_set_entitlements(p_tenant_id text,p_entitlements jsonb)
returns void language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare v_key text; v_value jsonb; v_budget jsonb; v_month numeric; v_user numeric; v_soft numeric; v_version text;
begin
  if p_entitlements is null or jsonb_typeof(p_entitlements)<>'object'
    or exists(select 1 from jsonb_object_keys(p_entitlements) k where k<>all(array['keyMode','tier','modelAllowlist','memberKeyModels','enabledConnectors','featureFlags','config','budget'])) then
    raise exception using errcode='22023',message='Unsupported entitlement fields';
  end if;
  perform 1 from public.tenants where tenant_id=p_tenant_id and status<>'offboarding' for update;
  if not found then raise exception using errcode='23503',message='Tenant not found or is offboarding'; end if;
  for v_key,v_value in select key,value from jsonb_each(p_entitlements) loop
    if (v_key='keyMode' and (jsonb_typeof(v_value)<>'string' or v_value#>>'{}' not in ('platform','byo','hybrid')))
      or (v_key='tier' and jsonb_typeof(v_value) not in ('string','null'))
      or (v_key in ('featureFlags','config') and jsonb_typeof(v_value)<>'object')
      or (v_key in ('modelAllowlist','memberKeyModels','enabledConnectors') and jsonb_typeof(v_value) not in ('array','null')) then
      raise exception using errcode='22023',message='Invalid entitlement value';
    end if;
    if v_key in ('modelAllowlist','memberKeyModels','enabledConnectors') and jsonb_typeof(v_value)='array' then
      if exists(select 1 from jsonb_array_elements(v_value) x where jsonb_typeof(x)<>'string' or nullif(btrim(x#>>'{}'),'') is null) then
        raise exception using errcode='22023',message='Entitlement lists must contain nonempty strings';
      end if;
    end if;
  end loop;
  insert into public.tenant_settings(tenant_id) values(p_tenant_id) on conflict do nothing;
  update public.tenant_settings set
    key_mode=case when p_entitlements?'keyMode' then p_entitlements->>'keyMode' else key_mode end,
    tier=case when p_entitlements?'tier' then p_entitlements->>'tier' else tier end,
    model_allowlist=case when p_entitlements?'modelAllowlist' then
      case when p_entitlements->'modelAllowlist'='null'::jsonb then null else array(select jsonb_array_elements_text(p_entitlements->'modelAllowlist')) end else model_allowlist end,
    member_key_models=case when p_entitlements?'memberKeyModels' then
      case when p_entitlements->'memberKeyModels'='null'::jsonb then null else array(select jsonb_array_elements_text(p_entitlements->'memberKeyModels')) end else member_key_models end,
    enabled_connectors=case when p_entitlements?'enabledConnectors' then
      case when p_entitlements->'enabledConnectors'='null'::jsonb then null else array(select jsonb_array_elements_text(p_entitlements->'enabledConnectors')) end else enabled_connectors end,
    feature_flags=case when p_entitlements?'featureFlags' then p_entitlements->'featureFlags' else feature_flags end,
    config=case when p_entitlements?'config' then p_entitlements->'config' else config end,updated_at=now()
    where tenant_id=p_tenant_id;
  v_budget:=p_entitlements->'budget';
  if v_budget is null or v_budget='null'::jsonb then
    delete from public.tenant_budgets where tenant_id=p_tenant_id;
  else
    if jsonb_typeof(v_budget)<>'object' or exists(select 1 from jsonb_object_keys(v_budget) k
      where k<>all(array['monthlyCredits','perUserCredits','softThreshold','priceVersion'])) then
      raise exception using errcode='22023',message='Invalid credit budget';
    end if;
    foreach v_key in array array['monthlyCredits','perUserCredits','softThreshold'] loop
      v_value:=v_budget->v_key;
      if v_value is null or v_value='null'::jsonb then
        if v_key='monthlyCredits' then raise exception using errcode='22023',message='monthlyCredits is required'; end if;
      elsif jsonb_typeof(v_value)<>'string' or (v_value#>>'{}') !~ '^[0-9]+(\.[0-9]+)?$' then
        raise exception using errcode='22023',message='Credits must be nonnegative finite decimal strings';
      end if;
    end loop;
    v_month:=(v_budget->>'monthlyCredits')::numeric;
    v_user:=(v_budget->>'perUserCredits')::numeric;
    v_soft:=(v_budget->>'softThreshold')::numeric;
    v_version:=v_budget->>'priceVersion';
    if jsonb_typeof(v_budget->'priceVersion') is distinct from 'string' or v_version is null
      or not exists(select 1 from app.credit_prices where version=v_version) then
      raise exception using errcode='23503',message='Published credit price version not found';
    end if;
    insert into public.tenant_budgets(tenant_id,monthly_credits,per_user_credits,soft_threshold,price_version)
      values(p_tenant_id,v_month,v_user,v_soft,v_version) on conflict (tenant_id) do update set
      monthly_credits=excluded.monthly_credits,per_user_credits=excluded.per_user_credits,
      soft_threshold=excluded.soft_threshold,price_version=excluded.price_version,updated_at=now();
  end if;
end $$;

do $$ declare v_gaps text; begin
  select string_agg(object || ': ' || problem, '; ') into v_gaps
    from (select * from app.tenant_rls_gaps() union all select * from app.control_plane_gaps()) g;
  if v_gaps is not null then raise exception 'tenant member keys: %', v_gaps; end if;
end $$;
notify pgrst, 'reload schema';
