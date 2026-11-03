-- Multi-tenant 014: tenant-owned configuration; secret VALUES never enter this table.
create table public.tenant_settings (
  tenant_id text primary key default app.tenant_id_default() references public.tenants(tenant_id),
  key_mode text not null default 'platform' check (key_mode in ('platform', 'byo')),
  tier text check (tier is null or tier ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  model_allowlist text[],
  enabled_connectors text[],
  feature_flags jsonb not null default '{}'::jsonb check (jsonb_typeof(feature_flags) = 'object'),
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  secret_refs jsonb not null default '{}'::jsonb check (jsonb_typeof(secret_refs) = 'object'),
  updated_at timestamptz not null default now()
);
-- Only non-secret endpoint/deployment/scope settings can use the value map.
-- OAuth client IDs and secrets, provider keys and endpoints use secret_refs.
create function app.validate_tenant_settings()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
declare v_key text; v_value jsonb;
begin
  for v_key, v_value in select key, value from jsonb_each(new.config) loop
    if not (v_key = any(array['azure-openai-api-version', 'azure-openai-deployment', 'openai-base-url', 'mcp-oauth-default-scope'])
      or v_key ~ '^[a-z0-9-]+-oauth-scope$') or jsonb_typeof(v_value) <> 'string' then
      raise exception using errcode = '23514', message = 'Unsupported non-secret tenant setting';
    end if;
  end loop;
  for v_key, v_value in select key, value from jsonb_each(new.feature_flags) loop
    if jsonb_typeof(v_value) <> 'boolean' then
      raise exception using errcode = '23514', message = 'Tenant feature flags must be booleans';
    end if;
  end loop;
  for v_key, v_value in select key, value from jsonb_each(new.secret_refs) loop
    if v_key !~ '^[a-z][a-z0-9-]{0,126}$' or jsonb_typeof(v_value) <> 'string'
      or (v_value #>> '{}') !~ '^[a-zA-Z][a-zA-Z0-9-]{0,126}$'
      or left(v_value #>> '{}', length('tenant-' || new.tenant_id || '-')) <> 'tenant-' || new.tenant_id || '-' then
      raise exception using errcode = '23514', message = 'Tenant secret references must name this tenant''s Key Vault secrets';
    end if;
  end loop;
  return new;
end $$;
revoke all on function app.validate_tenant_settings() from public, web_anon, authenticated;
create trigger validate_tenant_settings before insert or update on public.tenant_settings
  for each row execute function app.validate_tenant_settings();
select app.enable_tenant_rls('public.tenant_settings');
-- Ordinary requests may inspect their configuration, never replace credentials
-- or entitlements. Issue 018 provides the control-plane mutation contract.
revoke all on public.tenant_settings from public, web_anon, authenticated, tenant_app;
grant select on public.tenant_settings to tenant_app;
grant select, insert, update, delete on public.tenant_settings to service_role;
comment on column public.tenant_settings.secret_refs is 'Canonical config name -> tenant-prefixed Key Vault secret name; never a credential value.';
comment on column public.tenant_settings.model_allowlist is 'NULL inherits install policy; an empty array permits no models. Exact application model IDs, including router prefixes.';
comment on column public.tenant_settings.tier is 'Optional platform credential tier: platform-{tier}-{canonical-secret-name}, then install fallback.';
do $$ declare v_gaps text; begin
  select string_agg(object || ': ' || problem, '; ') into v_gaps from app.tenant_rls_gaps();
  if v_gaps is not null then raise exception 'multi-tenant 014: tenant RLS gaps: %', v_gaps; end if;
end $$;
notify pgrst, 'reload schema';
