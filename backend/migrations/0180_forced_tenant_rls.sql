-- Multi-tenant 008 (docs/issues/multi-tenant/008-forced-rls.md): forced
-- row-level security and the tenant_app role.
--
-- Design: docs/multi-tenant/003-target-architecture.md section 1, Layer 2.
--
--   tenant_app      nologin, no BYPASSRLS, owns nothing. The JWT role of
--                   every request-client call (lib/supabase.ts), with the
--                   request's tenant claim (or the install tenant on a
--                   single-tenant install); the stream cluster sets it on its
--                   raw pg sessions inside a tenant scope. No execute on the
--                   job-control (claim/renew/finish/defer_db_job) or platform
--                   functions. Granted to authenticator (PostgREST and the
--                   stream cluster connect as it; runMigrations.ts grants it
--                   again on installs where authenticator is created after
--                   migrating) and to the migration user (PostgREST's
--                   connecting role on older installs).
--   service_role    stays the platform role (BYPASSRLS, 0005): the platform
--                   client, job claiming, catalog sync. The 10 remaining
--                   platform security definer functions of 007 are re-owned
--                   to it, so they keep bypassing RLS when the migration user
--                   is not a superuser (Azure).
--   tenant_definer  (007) owns the tenant definer functions; it does not
--                   bypass RLS, so they see the caller's tenant only.
--
-- app.enable_tenant_rls(regclass) enables and forces RLS on a table (and on
-- each existing partition of a partitioned table) and (re)creates policy
-- tenant_isolation: tenant_id = app.current_tenant_id(), which is the JWT
-- claim or NULL, so a role subject to RLS without a claim sees no rows and
-- cannot write any. Idempotent; later migrations that add a tenant table
-- call it (select app.enable_tenant_rls('public.<table>');). The
-- single-tenant fallback stays in app.tenant_id_default() (column defaults)
-- only; the policy never falls back.
--
-- complete_google_drive_oauth / complete_google_workspace_oauth move from the
-- platform list to tenant_definer: they run from the authenticated
-- /oauth/finish routes, inside the user's tenant.
--
-- Global catalog tables (6) are read-only for tenant_app by grant and have no
-- RLS; migration bookkeeping, auth_oauth_states and stream_run_nodes have no
-- tenant_id (005) and are platform-only, except that tenant_app may read
-- stream_run_nodes (public keys of backend processes).
--
-- app.tenant_rls_gaps() is the migration gate: it lists every public table
-- that lacks tenant_id, forced RLS or tenant_isolation outside the allowlist,
-- every security definer function owned by an RLS-bypassing role outside
-- the platform allowlist, a tenant_app that could log in or bypass RLS, and
-- any platform or job-control function tenant_app may execute. This
-- migration fails unless it is empty; the canary suite (009) re-checks it
-- after all migrations.
--
-- Data migrations: the migration user bypasses RLS only if it is a superuser
-- or has BYPASSRLS. Otherwise (a WARNING below says so) a later migration
-- that reads or writes tenant rows must do it as service_role
-- (set local role service_role), or it sees no rows.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'tenant_app') then
    create role tenant_app nologin;
  end if;
  if exists (
    select 1 from pg_roles
     where rolname = 'tenant_app' and (rolsuper or rolbypassrls or rolcanlogin)
  ) then
    raise exception 'multi-tenant 008: tenant_app must be nologin, nosuperuser, nobypassrls';
  end if;
  execute format('grant tenant_app to %I', current_user);
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    grant tenant_app to authenticator;
  end if;
  if not exists (
    select 1 from pg_roles where rolname = current_user and (rolsuper or rolbypassrls)
  ) then
    raise warning 'multi-tenant 008: migration user % does not bypass RLS; data migrations on tenant tables must run as service_role', current_user;
  end if;
end $$;

grant usage on schema public to tenant_app;
grant usage on schema app to tenant_app;
grant select on app.install_tenancy to tenant_app;
grant execute on function app.current_tenant_id() to tenant_app;
grant execute on function app.tenant_id_default() to tenant_app;

grant select, insert, update, delete on all tables in schema public to tenant_app;
grant usage, select, update on all sequences in schema public to tenant_app;
revoke insert, update, delete on
  public.courtlistener_citation_index,
  public.courtlistener_opinion_cluster_index,
  public.mike_workflows,
  public.mike_workflow_assets,
  public.workflow_addons,
  public.workflow_addon_reference_files,
  public.stream_run_nodes
  from tenant_app;
-- Auto-onboarding (middleware/tenantAccess) inserts the caller's own row.
revoke update, delete on public.tenants from tenant_app;
revoke all on
  public.pgmigrations,
  public.organization_backfill_markers,
  public.auth_oauth_states
  from tenant_app;

alter default privileges in schema public
  grant select, insert, update, delete on tables to tenant_app;
alter default privileges in schema public
  grant usage, select, update on sequences to tenant_app;

-- ── Function ownership and execute grants ──────────────────────────────────
-- ALTER ... OWNER needs CREATE on the schema for the new owner; it is granted
-- for this migration and revoked again unless the role already held it.
do $$
declare
  v_platform text[] := array[
    'claim_upload_processing_job', 'expire_exhausted_upload_jobs',
    'replace_mike_workflows', 'document_lifecycle_version',
    'consume_auth_oauth_state', 'consume_auth_handoff',
    'claim_auth_session_refresh', 'finish_auth_session_refresh',
    'revoke_auth_session'
  ];
  v_google text[] := array['complete_google_drive_oauth', 'complete_google_workspace_oauth'];
  v_job_control text[] := array['claim_db_job', 'claim_db_jobs', 'renew_db_job', 'finish_db_job', 'defer_db_job'];
  v_had_public boolean := has_schema_privilege('service_role', 'public', 'CREATE');
  v_had_app boolean := has_schema_privilege('service_role', 'app', 'CREATE');
  v_definer_had_public boolean := has_schema_privilege('tenant_definer', 'public', 'CREATE');
  r record;
begin
  grant create on schema public to service_role, tenant_definer;
  grant create on schema app to service_role;
  grant update on app.install_tenancy to service_role;

  for r in
    select p.oid::regprocedure as sig, p.proname
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname = any (v_platform || v_google)
  loop
    if r.proname = any (v_google) then
      execute format('alter function %s owner to tenant_definer', r.sig);
      execute format('grant execute on function %s to tenant_app, service_role', r.sig);
    else
      execute format('alter function %s owner to service_role', r.sig);
    end if;
  end loop;
  alter function app.adopt_install_tenant() owner to service_role;

  -- tenant_app may call every tenant function; platform and job-control
  -- functions stay with service_role.
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prokind = 'f'
       and p.proname <> all (v_platform || v_job_control)
       and not exists (
         select 1 from pg_depend d
          where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
       )
  loop
    execute format('grant execute on function %s to tenant_app', r.sig);
  end loop;

  if not v_had_public then revoke create on schema public from service_role; end if;
  if not v_had_app then revoke create on schema app from service_role; end if;
  if not v_definer_had_public then revoke create on schema public from tenant_definer; end if;
end $$;

-- ── app.enable_tenant_rls ──────────────────────────────────────────────────
create or replace function app.enable_tenant_rls(p_table regclass)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_rel regclass;
begin
  if not exists (
    select 1 from pg_attribute
     where attrelid = p_table and attname = 'tenant_id' and not attisdropped
  ) then
    raise exception 'multi-tenant 008: % has no tenant_id column', p_table;
  end if;
  -- A partitioned table's policies apply only to queries through the parent;
  -- each existing partition is a table of its own and gets the same
  -- treatment. Partitions created later must call this function again.
  for v_rel in
    select p_table
    union
    select t.relid from pg_partition_tree(p_table) t where t.relid <> p_table
  loop
    execute format('alter table %s enable row level security', v_rel);
    execute format('alter table %s force row level security', v_rel);
    if exists (select 1 from pg_policy where polrelid = v_rel and polname = 'tenant_isolation') then
      execute format('drop policy tenant_isolation on %s', v_rel);
    end if;
    -- (select ...) makes the claim an init plan, evaluated once per statement.
    execute format(
      'create policy tenant_isolation on %s
         using (tenant_id = (select app.current_tenant_id()))
         with check (tenant_id = (select app.current_tenant_id()))',
      v_rel
    );
  end loop;
end;
$$;
revoke all on function app.enable_tenant_rls(regclass) from public;

do $$
declare
  r record;
begin
  for r in
    select c.oid::regclass as tbl
      from pg_class c
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
     where c.relnamespace = 'public'::regnamespace
       and c.relkind in ('r', 'p')
  loop
    perform app.enable_tenant_rls(r.tbl);
  end loop;
end $$;

-- ── Platform writes that fire tenant triggers ──────────────────────────────
-- Merge into main (2026-11-03): main's 0173 trigger function
-- document_text_job_failed (security definer, re-owned to tenant_definer by
-- 0178) now runs under RLS. The platform client marks jobs failed with no
-- tenant claim (finish_db_job from the runner, claim_db_jobs abandoning a
-- stale job), so app.current_tenant_id() was NULL inside the trigger and
-- fail_document_text_job saw no rows: document_version_texts stayed
-- pending/processing. The trigger now acts as the job row's own tenant: it
-- sets the tenant claim to new.tenant_id (transaction-local), calls the
-- canonical RPC and restores the caller's claims. Only the platform role can
-- update another tenant's job row (the tenant_isolation policy's WITH CHECK
-- confines a tenant caller to rows whose tenant_id is its claim; 0186 later
-- makes tenant_id immutable too), so this grants no tenant anything it could
-- not already reach.
-- Differences from 0173's body: a job with no tenant_id is skipped (no claim
-- to act as), and an offboarding tenant is skipped — 0194's
-- tenant_offboarding_fence would raise 42501 on the text-row write, and inside
-- claim_db_jobs' abandon sweep that would fail every worker's claim for every
-- tenant. The 42501 guard covers a tenant that starts offboarding between the
-- check and the write; the purge deletes the text rows anyway.
create or replace function public.document_text_job_failed()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare version_id uuid; revision uuid; v_claims text;
begin
  begin
    version_id:=(new.payload->>'versionId')::uuid;
    revision:=(new.payload->>'revision')::uuid;
  exception when invalid_text_representation then return null;
  end;
  if new.tenant_id is null then return null; end if;
  v_claims:=current_setting('request.jwt.claims',true);
  perform set_config('request.jwt.claims',
    (coalesce(nullif(v_claims,''),'{}')::jsonb || jsonb_build_object('tenant_id',new.tenant_id))::text, true);
  if not exists (select 1 from public.tenants where tenant_id=new.tenant_id and status='offboarding') then
    begin
      -- This trigger owns the actual failed-job transition, including the stale
      -- sweep that clears its token. Canonical RPC checks current failed row,
      -- attempt/token, revision and absence of a pending/running successor.
      perform public.fail_document_text_job(new.id,new.attempts,new.claim_token,version_id,revision);
    exception when insufficient_privilege then null;
    end;
  end if;
  perform set_config('request.jwt.claims',coalesce(v_claims,''),true);
  return null;
end;
$$;
do $$
begin
  -- create or replace keeps 0178's owner; the claim switch relies on it.
  if (select o.rolname from pg_proc p join pg_roles o on o.oid=p.proowner
       where p.oid='public.document_text_job_failed()'::regprocedure) <> 'tenant_definer' then
    raise exception 'multi-tenant 008: document_text_job_failed must be owned by tenant_definer';
  end if;
end $$;
revoke all on function public.document_text_job_failed() from public, web_anon, authenticated;
grant execute on function public.document_text_job_failed() to service_role;

-- ── Migration gate ─────────────────────────────────────────────────────────
create or replace function app.tenant_rls_gaps()
returns table (object text, problem text)
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select c.oid::regclass::text,
         case
           when a.attname is null then 'no tenant_id column'
           when not c.relrowsecurity then 'row level security is not enabled'
           when not c.relforcerowsecurity then 'row level security is not forced'
           else 'no tenant_isolation policy'
         end
    from pg_class c
    left join pg_attribute a
      on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
   where c.relnamespace = 'public'::regnamespace
     and c.relkind in ('r', 'p')
     and c.relname <> all (array[
       'courtlistener_citation_index', 'courtlistener_opinion_cluster_index',
       'mike_workflows', 'mike_workflow_assets', 'workflow_addons',
       'workflow_addon_reference_files',
       'pgmigrations', 'organization_backfill_markers', 'auth_oauth_states',
       'stream_run_nodes'
     ])
     and (
       a.attname is null
       or not c.relrowsecurity
       or not c.relforcerowsecurity
       or not exists (
         select 1 from pg_policy p
          where p.polrelid = c.oid and p.polname = 'tenant_isolation'
       )
     )
  union all
  select r.rolname::text, 'role must be nologin, nosuperuser and nobypassrls'
    from pg_roles r
   where r.rolname = 'tenant_app'
     and (r.rolsuper or r.rolbypassrls or r.rolcanlogin)
  union all
  select p.oid::regprocedure::text,
         'tenant_app may execute a platform or job-control function'
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname = any (array[
       'claim_upload_processing_job', 'expire_exhausted_upload_jobs',
       'replace_mike_workflows', 'document_lifecycle_version',
       'consume_auth_oauth_state', 'consume_auth_handoff',
       'claim_auth_session_refresh', 'finish_auth_session_refresh',
       'revoke_auth_session',
       'claim_db_job', 'claim_db_jobs', 'renew_db_job', 'finish_db_job', 'defer_db_job'
     ])
     and exists (select 1 from pg_roles where rolname = 'tenant_app')
     and has_function_privilege('tenant_app', p.oid, 'execute')
  union all
  select p.oid::regprocedure::text,
         'security definer function owned by an RLS-bypassing role'
    from pg_proc p
    join pg_roles o on o.oid = p.proowner
   where p.pronamespace in ('public'::regnamespace, 'app'::regnamespace)
     and p.prosecdef
     and (o.rolsuper or o.rolbypassrls)
     and p.proname <> all (array[
       'claim_upload_processing_job', 'expire_exhausted_upload_jobs',
       'replace_mike_workflows', 'document_lifecycle_version',
       'consume_auth_oauth_state', 'consume_auth_handoff',
       'claim_auth_session_refresh', 'finish_auth_session_refresh',
       'revoke_auth_session', 'adopt_install_tenant'
     ])
   order by 1
$$;
revoke all on function app.tenant_rls_gaps() from public;
grant execute on function app.tenant_rls_gaps() to service_role;

do $$
declare
  v_gaps text;
begin
  select string_agg(object || ': ' || problem, '; ') into v_gaps from app.tenant_rls_gaps();
  if v_gaps is not null then
    raise exception 'multi-tenant 008: tenant RLS gaps: %', v_gaps;
  end if;
end $$;

notify pgrst, 'reload schema';
