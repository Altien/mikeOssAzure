-- Multi-tenant 013: system ownership is tenant-local. Keep existing blob paths
-- and tenant IDs intact; only the synthetic actor changes.
set local role service_role;
do $migration$
declare t record;
begin
  for t in select distinct tenant_id from public.projects
    where user_id = 'system:external-provenance'
    union select distinct tenant_id from public.documents
    where user_id = 'system:external-provenance'
  loop
    perform set_config('request.jwt.claims', json_build_object('tenant_id', t.tenant_id)::text, true);
    update public.projects
      set user_id = 'system:external-provenance:' || t.tenant_id
      where tenant_id = t.tenant_id and user_id = 'system:external-provenance';
    update public.documents
      set user_id = 'system:external-provenance:' || t.tenant_id
      where tenant_id = t.tenant_id and user_id = 'system:external-provenance';
  end loop;
  perform set_config('request.jwt.claims', '{}', true);
end;
$migration$;
reset role;
do $$ declare v_gaps text; begin
  select string_agg(object || ': ' || problem, '; ') into v_gaps from app.tenant_rls_gaps();
  if v_gaps is not null then raise exception 'multi-tenant 013: tenant RLS gaps: %', v_gaps; end if;
end $$;
