-- Model catalogue for the control plane (docs/multi-tenant/control-plane-contract.md).
-- The models this build accepts in memberKeyModels: the same for every tenant,
-- so not tenant data. The table lives in app, outside the tenant RLS gate; the
-- migration job replaces its rows after every deploy (src/lib/llm/modelCatalog.ts)
-- so they match the running image. Only the view is a contract surface.
create table app.model_catalog (
  model_id text primary key check (btrim(model_id) <> ''),
  provider text not null check (btrim(provider) <> ''),
  label text not null check (btrim(label) <> ''),
  sort_order integer not null
);
revoke all on app.model_catalog from public, web_anon, authenticated, tenant_app, tenant_definer, service_role, control_plane;
grant select on app.model_catalog to service_role;

create view public.cp_models with (security_barrier=true) as
  select model_id, provider, label from app.model_catalog order by sort_order, model_id;

do $$ declare v_had boolean := has_schema_privilege('service_role', 'public', 'CREATE'); begin
  grant create on schema public to service_role;
  alter view public.cp_models owner to service_role;
  if not v_had then revoke create on schema public from service_role; end if;
end $$;
revoke all on public.cp_models from public, web_anon, authenticated, tenant_app, tenant_definer;
grant select on public.cp_models to control_plane;

-- Extend the control_plane readable-view set.
do $$ declare v_old text; v_new text; begin
  select pg_get_functiondef('app.control_plane_gaps()'::regprocedure) into v_old;
  v_new := replace(v_old, '''public.cp_daily_usage''::regclass,',
    '''public.cp_models''::regclass,''public.cp_daily_usage''::regclass,');
  if v_new = v_old then raise exception 'anchor not found'; end if;
  execute v_new;
end $$;

do $$ declare v_gaps text; begin
  select string_agg(object || ': ' || problem, '; ') into v_gaps
    from (select * from app.tenant_rls_gaps() union all select * from app.control_plane_gaps()) g;
  if v_gaps is not null then raise exception 'model catalog: %', v_gaps; end if;
end $$;
notify pgrst, 'reload schema';
