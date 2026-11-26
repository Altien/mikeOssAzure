-- Multi-tenant 007 (docs/issues/multi-tenant/007-security-definer-audit.md):
-- make SQL functions and views respect tenant RLS.
--
-- A security definer function runs as its owner. Every function here was
-- owned by the migration user, which owns the tables (owners skip RLS unless
-- FORCE) and is a superuser locally, so once RLS is on (issue 008) such a
-- function would return every tenant's rows.
--
-- Approach: keep each function's body and SECURITY DEFINER attribute and give
-- it a new owner, tenant_definer: nologin, not superuser, no BYPASSRLS, owns
-- no tables. Under 008's policies a function owned by tenant_definer sees only
-- the tenant in the request's JWT claim, like the caller. Today (no RLS)
-- behaviour is unchanged: tenant_definer holds the same table and function
-- rights the functions used through the old owner.
-- Owner change rather than SECURITY INVOKER: a later upstream
-- "create or replace function ... security definer" resets the attribute but
-- keeps the owner, so this survives upstream syncs without touching bodies.
--
-- Platform functions are cross-tenant by design and keep their owner. They
-- run before a tenant is known or span tenants, and stay EXECUTE-able only by
-- service_role (008 moves that to the platform role):
--   claim_upload_processing_job, expire_exhausted_upload_jobs  (worker claim
--     and sweep across tenants)
--   replace_mike_workflows  (catalog sync)
--   document_lifecycle_version  (startup probe)
--   consume_auth_oauth_state, consume_auth_handoff,
--   claim_auth_session_refresh, finish_auth_session_refresh,
--   revoke_auth_session  (sign-in and session lookup by hash, before the
--     tenant is known)
--   complete_google_drive_oauth, complete_google_workspace_oauth  (OAuth
--     callback looks the state up by hash before the tenant is known)
--   app.adopt_install_tenant  (0106 install bookkeeping trigger)
-- Invoker functions (claim_db_jobs, get_*_overview, ...) already run with the
-- caller's rights and RLS; they need no change.
--
-- Views: none exist in public today; any present are set security_invoker.
-- The final block asserts the end state: no security definer function in
-- public or app is owned by a superuser or BYPASSRLS role outside the
-- allowlist, and no view lacks security_invoker.
-- Grants use explicit signatures. CREATE on schema public is needed only for
-- ALTER ... OWNER and is revoked again at the end.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'tenant_definer') then
    create role tenant_definer nologin;
  end if;
end $$;

-- The migration user must be able to SET ROLE tenant_definer to hand it
-- ownership (and to create or replace its functions in later migrations).
do $$
begin
  execute format('grant tenant_definer to %I', current_user);
end $$;

grant usage on schema public to tenant_definer;
grant usage on schema app to tenant_definer;
grant select on app.install_tenancy to tenant_definer;
grant execute on function app.current_tenant_id() to tenant_definer;
grant execute on function app.tenant_id_default() to tenant_definer;

grant select, insert, update, delete on all tables in schema public to tenant_definer;
grant usage, select, update on all sequences in schema public to tenant_definer;
-- Global catalog and the tenant registry are read-only to tenant code;
-- bookkeeping and pre-sign-in / per-process tables are platform-only.
revoke insert, update, delete on
  public.courtlistener_citation_index,
  public.courtlistener_opinion_cluster_index,
  public.mike_workflows,
  public.mike_workflow_assets,
  public.workflow_addons,
  public.workflow_addon_reference_files,
  public.tenants
  from tenant_definer;
revoke all on
  public.pgmigrations,
  public.organization_backfill_markers,
  public.auth_oauth_states,
  public.stream_run_nodes
  from tenant_definer;

alter default privileges in schema public
  grant select, insert, update, delete on tables to tenant_definer;
alter default privileges in schema public
  grant usage, select, update on sequences to tenant_definer;
alter default privileges in schema public
  grant execute on functions to tenant_definer;

grant create on schema public to tenant_definer;

do $$
declare
  v_platform text[] := array[
    'claim_upload_processing_job', 'expire_exhausted_upload_jobs',
    'replace_mike_workflows', 'document_lifecycle_version',
    'consume_auth_oauth_state', 'consume_auth_handoff',
    'claim_auth_session_refresh', 'finish_auth_session_refresh',
    'revoke_auth_session',
    'complete_google_drive_oauth', 'complete_google_workspace_oauth'
  ];
  r record;
begin
  -- tenant functions may call any non-platform function in public
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prokind = 'f'
       and p.proname <> all (v_platform)
  loop
    execute format('grant execute on function %s to tenant_definer', r.sig);
  end loop;

  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_roles o on o.oid = p.proowner
     where p.pronamespace = 'public'::regnamespace
       and p.prosecdef
       and p.proname <> all (v_platform)
       and o.rolname <> 'tenant_definer'
       and not exists (
         select 1 from pg_depend d
          where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
       )
  loop
    execute format('alter function %s owner to tenant_definer', r.sig);
  end loop;

  for r in
    select c.oid::regclass as view_name
      from pg_class c
     where c.relnamespace in ('public'::regnamespace, 'app'::regnamespace)
       and c.relkind = 'v'
       and not coalesce(c.reloptions @> array['security_invoker=true'], false)
  loop
    execute format('alter view %s set (security_invoker = true)', r.view_name);
  end loop;
end $$;

revoke create on schema public from tenant_definer;

-- End-state check (the acceptance query of issue 007).
do $$
declare
  v_allow text[] := array[
    'claim_upload_processing_job', 'expire_exhausted_upload_jobs',
    'replace_mike_workflows', 'document_lifecycle_version',
    'consume_auth_oauth_state', 'consume_auth_handoff',
    'claim_auth_session_refresh', 'finish_auth_session_refresh',
    'revoke_auth_session',
    'complete_google_drive_oauth', 'complete_google_workspace_oauth',
    'adopt_install_tenant'
  ];
  v_bad text;
begin
  if exists (
    select 1 from pg_roles
     where rolname = 'tenant_definer' and (rolsuper or rolbypassrls or rolcanlogin)
  ) then
    raise exception 'multi-tenant 007: tenant_definer must be nologin, nosuperuser, nobypassrls';
  end if;

  select string_agg(p.oid::regprocedure::text, ', ')
    into v_bad
    from pg_proc p
    join pg_roles o on o.oid = p.proowner
   where p.pronamespace in ('public'::regnamespace, 'app'::regnamespace)
     and p.prosecdef
     and (o.rolsuper or o.rolbypassrls)
     and p.proname <> all (v_allow);
  if v_bad is not null then
    raise exception 'multi-tenant 007: security definer functions owned by an RLS-bypassing role: %', v_bad;
  end if;

  select string_agg(c.oid::regclass::text, ', ')
    into v_bad
    from pg_class c
   where c.relnamespace in ('public'::regnamespace, 'app'::regnamespace)
     and c.relkind = 'v'
     and not coalesce(c.reloptions @> array['security_invoker=true'], false);
  if v_bad is not null then
    raise exception 'multi-tenant 007: views without security_invoker: %', v_bad;
  end if;
end $$;

notify pgrst, 'reload schema';
