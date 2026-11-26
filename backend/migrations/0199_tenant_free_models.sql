-- Free managed models: the current tenant's models priced at zero on its price
-- version, so the model picker can warn that such a provider keeps prompts and
-- responses. tenant_app cannot read app.credit_prices, so this definer
-- function, owned by tenant_definer like reserve_tenant_credits, returns only
-- the provider/model keys of the caller's own zero-price rows.
create function public.tenant_free_models()
returns table(provider text, model text) language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select p.provider, p.model
    from public.tenant_budgets b
    join app.credit_prices p on p.version = b.price_version
   where b.tenant_id = app.current_tenant_id()
     and p.input_per_million = 0 and p.output_per_million = 0
     and p.cache_read_per_million = 0 and p.cache_write_per_million = 0
$$;

do $$ declare v_had boolean := has_schema_privilege('tenant_definer', 'public', 'CREATE'); begin
  grant create on schema public to tenant_definer;
  alter function public.tenant_free_models() owner to tenant_definer;
  if not v_had then revoke create on schema public from tenant_definer; end if;
end $$;
revoke all on function public.tenant_free_models() from public, web_anon, authenticated, tenant_app;
grant execute on function public.tenant_free_models() to tenant_app, service_role;

do $$ declare v_gaps text; begin
  select string_agg(object || ': ' || problem, '; ') into v_gaps from app.tenant_rls_gaps();
  if v_gaps is not null then raise exception 'tenant free models: tenant RLS gaps: %', v_gaps; end if;
end $$;
notify pgrst, 'reload schema';
