-- 012: per-user state must start fresh after a pooled membership move.
-- Global object UUID keys remain unchanged; these natural keys are tenant-owned.
--
-- Renumbered from 0122 when multi-tenant merged into main. Main's 0168 moved
-- the Google token tables to an id primary key plus a per-workspace key
-- (user_id, org_id[, provider]) UNIQUE NULLS NOT DISTINCT, added the same key
-- on user_courtlistener_connections, and 0119 added one personal organization
-- per person (organizations_personal_user_key). Those keys, and the conflict
-- targets that use them, become tenant-scoped here too; NULLS NOT DISTINCT
-- is kept (null org_id is Personal).
do $$
declare
  r record;
  c record;
begin
  for r in select * from (values
    ('user_google_drive_tokens', array['user_id','org_id']::text[]),
    ('user_google_workspace_tokens', array['user_id','org_id','provider']::text[]),
    ('user_courtlistener_connections', array['user_id','org_id']::text[]),
    ('user_api_keys', array['user_id','provider']::text[]),
    ('user_router_models', array['user_id','router','model_id']::text[]),
    ('word_documents', array['user_id','client_document_id']::text[])
  ) as keys(table_name, columns)
  loop
    for c in
      select con.conname, con.contype, i.indnullsnotdistinct
        from pg_constraint con
        join pg_index i on i.indexrelid = con.conindid
       where con.conrelid = to_regclass('public.' || r.table_name)
         and con.contype in ('p','u')
         and (select array_agg(a.attname::text order by k.ord)
                from unnest(con.conkey) with ordinality k(attnum,ord)
                join pg_attribute a on a.attrelid=con.conrelid and a.attnum=k.attnum) = r.columns
    loop
      execute format('alter table public.%I drop constraint %I', r.table_name, c.conname);
      execute format('alter table public.%I add constraint %I %s (tenant_id, %s)',
        r.table_name, c.conname,
        case when c.contype = 'p' then 'primary key'
             when c.indnullsnotdistinct then 'unique nulls not distinct'
             else 'unique' end,
        array_to_string(r.columns, ', '));
    end loop;
  end loop;
end $$;

-- One personal organization per person per tenant (main's 0119 key).
drop index if exists public.organizations_personal_user_key;
create unique index if not exists organizations_personal_user_key
  on public.organizations(tenant_id, personal_user_id)
  where personal_user_id is not null;

-- Keep the OAuth and personal-organization bodies, tenant_definer ownership
-- and existing fenced state consumption; only their conflict targets change
-- to the scoped keys above.
do $$
declare v_definition text;
begin
  select pg_get_functiondef('public.complete_google_drive_oauth(text,jsonb)'::regprocedure) into v_definition;
  v_definition := regexp_replace(v_definition, 'on conflict \(user_id, org_id\)', 'on conflict (tenant_id, user_id, org_id)', 'gi');
  execute v_definition;
  select pg_get_functiondef('public.complete_google_workspace_oauth(text,text,jsonb)'::regprocedure) into v_definition;
  v_definition := regexp_replace(v_definition, 'on conflict \(user_id, org_id, provider\)', 'on conflict (tenant_id, user_id, org_id, provider)', 'gi');
  execute v_definition;
  select pg_get_functiondef('public.ensure_personal_organization(text)'::regprocedure) into v_definition;
  v_definition := regexp_replace(v_definition, 'on conflict \(personal_user_id\)', 'on conflict (tenant_id, personal_user_id)', 'gi');
  execute v_definition;
end $$;

revoke all on function public.complete_google_drive_oauth(text,jsonb),
  public.complete_google_workspace_oauth(text,text,jsonb) from public, web_anon, authenticated;
grant execute on function public.complete_google_drive_oauth(text,jsonb),
  public.complete_google_workspace_oauth(text,text,jsonb) to tenant_app, service_role;

do $$
begin
  if exists (select 1 from app.tenant_rls_gaps()) then
    raise exception 'multi-tenant 012: tenant RLS gate failed';
  end if;
end $$;
notify pgrst, 'reload schema';
