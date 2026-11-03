-- Multi-tenant 005 (docs/issues/multi-tenant/005-tenant-id-columns.md):
-- add tenant_id to every tenant-owned table.
--
-- Design: docs/multi-tenant/003-target-architecture.md section 1, Layer 2.
-- Every tenant-owned table gets
--
--   tenant_id text not null default app.tenant_id_default()
--     references public.tenants(tenant_id)
--
-- so existing upstream insert code never sets tenant_id: the database fills
-- it from the request. app.tenant_id_default() returns, in order:
--
--   1. the tenant_id claim of the PostgREST JWT (request.jwt.claims, sent by
--      issue 002; stream runs set the same GUC per transaction, issue 003);
--   2. otherwise, on a single-tenant install only, the install's tenant
--      (app.install_tenancy.fallback_tenant_id);
--   3. otherwise NULL, which the not-null constraint rejects (fail closed).
--
-- Step 2 keeps today's single-tenant installs working before and after
-- phase 1: requests without a claim (no phase 1 yet, unauthenticated routes
-- such as the sign-in callback, scripts) still land in the one tenant.
-- A pooled stamp sets app.install_tenancy.pooled = true (issues 018/019),
-- which disables the fallback.
--
-- Choosing the install tenant (once, here; idempotent):
--   - exactly one public.tenants row (every Entra install that has signed
--     in): that row, i.e. the Entra tid;
--   - several rows: the oldest active one, with a WARNING;
--   - no rows but tenant-owned data exists (local / supabase installs, which
--     never write tenants): insert tenant 'default', matching phase 1's
--     local fallback key (issue 001 "default-tenant-id", default "default");
--   - no rows and no data (fresh database): left unset. The trigger below
--     adopts the first tenant inserted into public.tenants, which phase 1's
--     startup upsert of the install tenant provides before the API listens.
--
-- Scope (docs/multi-tenant/002-codebase-readiness.md section 2): every
-- public table except
--   - the 6 global catalog tables (courtlistener_citation_index,
--     courtlistener_opinion_cluster_index, mike_workflows,
--     mike_workflow_assets, workflow_addons, workflow_addon_reference_files);
--   - the 12 tables that already carry tenant_id (tenants itself,
--     tenant_group_policies and the Altien Skills tables);
--   - pgmigrations and organization_backfill_markers (migration bookkeeping);
--   - auth_oauth_states (written before sign-in, when no tenant is known);
--   - stream_run_nodes (one row per backend process, shared by all tenants).
-- Renumbered from 0106 when multi-tenant merged into main (it now runs after
-- main's 0106-0175); the list below also covers main's tables added after
-- the 0105 base.
-- Child tables get the same column; existing rows of the three Altien Skills
-- children copy tenant_id from their parent, all other rows take the install
-- tenant (identical to the parent's on a single-tenant install).
--
-- Adding a column whose default is not immutable rewrites the table and
-- evaluates the default for every existing row, which is the backfill.
-- add column if not exists: issue 003 also adds tenant_id to db_jobs,
-- upload_processing_jobs and stream_runs; whichever migration runs first
-- wins and the other is a no-op.
-- Grants: the app schema and its functions are explicit, per role.

create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;

create table if not exists app.install_tenancy (
  singleton boolean primary key default true check (singleton),
  pooled boolean not null default false,
  fallback_tenant_id text
    references public.tenants(tenant_id) on delete set null,
  updated_at timestamptz not null default now()
);
revoke all on app.install_tenancy from public, web_anon, authenticated, service_role;
grant select on app.install_tenancy to authenticated, service_role;

-- The tenant claim, or NULL. Issue 008's policies compare against this.
create or replace function app.current_tenant_id()
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select nullif(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'tenant_id',
    ''
  )
$$;

-- Column default for tenant_id: the claim, else the single-tenant fallback.
create or replace function app.tenant_id_default()
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    app.current_tenant_id(),
    (select t.fallback_tenant_id
       from app.install_tenancy t
      where not t.pooled)
  )
$$;

revoke all on function app.current_tenant_id() from public;
revoke all on function app.tenant_id_default() from public;
grant execute on function app.current_tenant_id() to authenticated, service_role;
grant execute on function app.tenant_id_default() to authenticated, service_role;

-- A fresh single-tenant database adopts the first tenant it sees.
create or replace function app.adopt_install_tenant()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  update app.install_tenancy
     set fallback_tenant_id = new.tenant_id, updated_at = now()
   where fallback_tenant_id is null
     and not pooled;
  return null;
end;
$$;
revoke all on function app.adopt_install_tenant() from public;

drop trigger if exists tenants_adopt_install_tenant on public.tenants;
create trigger tenants_adopt_install_tenant
  after insert on public.tenants
  for each row execute function app.adopt_install_tenant();

do $$
declare
  v_tables text[] := array[
    -- user-owned
    'user_profiles', 'user_api_keys', 'user_router_models',
    'user_mcp_connectors', 'user_mcp_oauth_states', 'user_mcp_tool_audit_logs',
    'user_google_drive_tokens', 'user_google_workspace_tokens',
    'google_drive_oauth_states', 'google_workspace_oauth_states',
    'google_workspace_actions', 'projects', 'project_subfolders', 'documents',
    'library_folders', 'chats', 'tabular_reviews', 'tabular_review_chats',
    'word_chats', 'word_documents', 'workflows', 'workflow_reference_documents',
    'quick_actions', 'hidden_workflows', 'default_workflow_installations',
    'citation_verification_runs', 'citation_verification_extractions',
    'citation_verification_reviews', 'external_source_cache', 'memory_files',
    'memory_consolidation_states', 'memory_conversation_activity',
    'audit_events', 'workflow_open_source_submissions',
    'account_erasure_requests', 'account_erasure_storage_paths',
    'upload_sessions',
    -- sharing / org
    'organizations', 'org_members', 'org_invitations', 'project_access_grants',
    'chat_access_grants', 'tabular_review_access_grants',
    'project_org_access_overrides', 'workflow_org_access_overrides',
    'workflow_shares', 'tabular_review_legacy_shares',
    -- child rows scoped only through a parent
    'chat_messages', 'document_versions', 'document_edits', 'tabular_cells',
    'tabular_review_rows', 'tabular_review_row_sources',
    'tabular_review_chat_messages', 'word_chat_messages', 'word_document_edits',
    'upload_session_files', 'upload_session_parts', 'user_mcp_connector_tools',
    'user_mcp_oauth_tokens', 'memory_consolidation_results',
    'altien_skill_versions', 'altien_skill_dependencies',
    'altien_skill_import_messages',
    -- auth / session (auth_oauth_states is pre-sign-in, excluded)
    'auth_sessions', 'auth_handoff_tickets',
    -- jobs / runtime (stream_run_nodes is per-process, excluded)
    'db_jobs', 'upload_processing_jobs', 'stream_runs', 'stream_run_tool_calls',
    'memory_conversation_turn_leases',
    -- main's tables added after the 0105 base (0115-0172), all tenant-owned
    'org_api_keys', 'org_router_models', 'org_logos', 'org_departure_archives',
    'org_departure_events', 'org_private_content_access',
    'user_courtlistener_connections', 'document_version_texts',
    'playbooks', 'playbook_sources', 'playbook_shares',
    'playbook_org_access_overrides', 'playbook_runs', 'playbook_imports',
    'chat_subagent_runs'
  ];
  v_table text;
  v_tenant text;
  v_count integer;
  v_has_data boolean := false;
begin
  insert into app.install_tenancy (singleton) values (true)
  on conflict (singleton) do nothing;

  select fallback_tenant_id into v_tenant from app.install_tenancy;
  if v_tenant is null and not (select pooled from app.install_tenancy) then
    select count(*) into v_count from public.tenants;
    if v_count >= 1 then
      select tenant_id into v_tenant
        from public.tenants
       order by (status = 'active') desc, created_at, tenant_id
       limit 1;
      if v_count > 1 then
        raise warning 'multi-tenant 005: % tenants rows; using % as the install tenant',
          v_count, v_tenant;
      end if;
    else
      foreach v_table in array v_tables loop
        if to_regclass('public.' || v_table) is not null then
          execute format('select exists (select 1 from public.%I)', v_table)
            into v_has_data;
          exit when v_has_data;
        end if;
      end loop;
      if v_has_data then
        v_tenant := 'default';
        insert into public.tenants (tenant_id, status)
        values (v_tenant, 'active')
        on conflict (tenant_id) do nothing;
      end if;
    end if;
    update app.install_tenancy
       set fallback_tenant_id = v_tenant, updated_at = now();
  end if;

  foreach v_table in array v_tables loop
    execute format(
      'alter table public.%I add column if not exists tenant_id text not null '
      'default app.tenant_id_default() references public.tenants(tenant_id)',
      v_table
    );
    -- Re-assert the default in case another migration added the column
    -- with a claim-only default.
    execute format(
      'alter table public.%I alter column tenant_id set default app.tenant_id_default()',
      v_table
    );
  end loop;
end $$;

-- Altien Skills children follow their parent's tenant (the parents already
-- carried tenant_id before this migration).
update public.altien_skill_versions v
   set tenant_id = s.tenant_id
  from public.altien_skills s
 where s.id = v.skill_id
   and v.tenant_id is distinct from s.tenant_id;
update public.altien_skill_dependencies d
   set tenant_id = v.tenant_id
  from public.altien_skill_versions v
 where v.id = d.version_id
   and d.tenant_id is distinct from v.tenant_id;
update public.altien_skill_import_messages m
   set tenant_id = c.tenant_id
  from public.altien_skill_import_conversations c
 where c.id = m.conversation_id
   and m.tenant_id is distinct from c.tenant_id;

-- Tenant-leading variants of the hot list indexes behind the get_*_overview
-- RPCs and email-keyed grant lookups. The upstream indexes stay.
create index if not exists projects_tenant_user_idx
  on public.projects (tenant_id, user_id);
create index if not exists projects_tenant_updated_at_idx
  on public.projects (tenant_id, updated_at desc, id);
create index if not exists chats_tenant_user_created_idx
  on public.chats (tenant_id, user_id, created_at desc, id);
create index if not exists chats_tenant_updated_at_idx
  on public.chats (tenant_id, updated_at desc, id);
create index if not exists documents_tenant_user_project_idx
  on public.documents (tenant_id, user_id, project_id);
create index if not exists tabular_reviews_tenant_user_idx
  on public.tabular_reviews (tenant_id, user_id);
create index if not exists workflows_tenant_user_idx
  on public.workflows (tenant_id, user_id);
create index if not exists user_profiles_tenant_email_idx
  on public.user_profiles (tenant_id, lower(email));
create index if not exists project_access_grants_tenant_email_idx
  on public.project_access_grants (tenant_id, email);
create index if not exists chat_access_grants_tenant_email_idx
  on public.chat_access_grants (tenant_id, email);
create index if not exists tabular_review_access_grants_tenant_email_idx
  on public.tabular_review_access_grants (tenant_id, email);
create index if not exists workflow_shares_tenant_email_idx
  on public.workflow_shares (tenant_id, shared_with_email);

notify pgrst, 'reload schema';
