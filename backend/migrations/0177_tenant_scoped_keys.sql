-- Multi-tenant 006 (docs/issues/multi-tenant/006-tenant-scoped-keys.md):
-- tenant-scoped uniques and composite foreign keys.
--
-- Unique, primary-key and foreign-key checks are not filtered by RLS
-- (docs/multi-tenant/001-azure-platform-research.md section 1.4). A global
-- unique leaks existence across tenants, and a single-column FK lets a row in
-- one tenant point at a parent in another, even as service_role.
--
-- 1. Composite foreign keys. Every FK between two public tables that both
--    carry tenant_id (0106) becomes (tenant_id, <cols>) references
--    parent(tenant_id, <cols>), keeping its name and actions. ON DELETE
--    SET NULL becomes SET NULL (<cols>) so tenant_id itself is never nulled
--    (Postgres 15+). The parent gets unique (tenant_id, <cols>) where no such
--    index exists. MATCH SIMPLE is kept, so a null <col> is still unchecked.
--    Driven from the catalog so it covers every such FK, including those
--    from the 11 tables that already had tenant_id. Not converted: FKs to
--    public.tenants (already the tenant key) and stream_runs.owner_instance
--    (stream_run_nodes is per-process and has no tenant).
--    Each FK is re-added NOT VALID and then validated; a row that already
--    crosses tenants (only possible if Altien Skills rows were keyed to a
--    different tenant than the install tenant 0106 chose) leaves that FK
--    unvalidated with a WARNING instead of failing the deploy. New writes
--    are enforced either way.
-- 2. Global uniques become tenant-scoped (same index/constraint names where
--    they were indexes): user_mcp_connector_tools.openai_tool_name,
--    projects.provenance_key (both partial indexes), the db_jobs live dedupe
--    key, the stream_runs live run key, and user_profiles.user_id.
-- 3. request_account_erasure (main's latest body, 0126) is re-created with
--    its ON CONFLICT target moved to the new db_jobs index; the body is
--    otherwise unchanged and create or replace keeps its owner and grants.
--
-- Backend: the two user_profiles upserts now use
-- onConflict "tenant_id,user_id" (tenant_id comes from the column default),
-- and userLookup's email lookups filter by the current tenant.
-- Idempotent: re-running converts nothing that already includes tenant_id.

do $$
declare
  r record;
  v_child_cols text;
  v_parent_cols text;
  v_parent_tenant smallint;
  v_key_name text;
  v_on_delete text;
  v_on_update text;
  v_deferrable text;
begin
  for r in
    select c.conname,
           c.conrelid,
           c.confrelid,
           c.conkey,
           c.confkey,
           c.confdeltype,
           c.confupdtype,
           c.condeferrable,
           c.condeferred,
           cr.relname as child_name,
           pr.relname as parent_name,
           ct.attnum as child_tenant
      from pg_constraint c
      join pg_class cr on cr.oid = c.conrelid
      join pg_class pr on pr.oid = c.confrelid
      join pg_attribute ct
        on ct.attrelid = c.conrelid and ct.attname = 'tenant_id' and not ct.attisdropped
     where c.contype = 'f'
       and cr.relnamespace = 'public'::regnamespace
       and pr.relnamespace = 'public'::regnamespace
       and pr.relname <> 'tenants'
       and not (ct.attnum = any (c.conkey))
       and exists (
         select 1 from pg_attribute pt
          where pt.attrelid = c.confrelid and pt.attname = 'tenant_id'
            and not pt.attisdropped
       )
     order by cr.relname, c.conname
  loop
    select string_agg(quote_ident(a.attname), ', ' order by k.ord)
      into v_child_cols
      from unnest(r.conkey) with ordinality as k(attnum, ord)
      join pg_attribute a on a.attrelid = r.conrelid and a.attnum = k.attnum;
    select string_agg(quote_ident(a.attname), ', ' order by k.ord)
      into v_parent_cols
      from unnest(r.confkey) with ordinality as k(attnum, ord)
      join pg_attribute a on a.attrelid = r.confrelid and a.attnum = k.attnum;
    select attnum into v_parent_tenant
      from pg_attribute
     where attrelid = r.confrelid and attname = 'tenant_id' and not attisdropped;

    if not exists (
      select 1 from pg_index i
       where i.indrelid = r.confrelid
         and i.indisunique
         and i.indpred is null
         and i.indexprs is null
         and i.indkey::text = array_to_string(array[v_parent_tenant] || r.confkey, ' ')
    ) then
      v_key_name := left(
        r.parent_name || '_tenant_id_' ||
          replace(replace(v_parent_cols, ', ', '_'), '"', '') || '_key',
        63
      );
      execute format(
        'alter table public.%I add constraint %I unique (tenant_id, %s)',
        r.parent_name, v_key_name, v_parent_cols
      );
    end if;

    v_on_delete := case r.confdeltype
      when 'c' then 'cascade'
      when 'r' then 'restrict'
      when 'n' then 'set null (' || v_child_cols || ')'
      when 'd' then 'set default (' || v_child_cols || ')'
      else 'no action'
    end;
    v_on_update := case r.confupdtype
      when 'c' then 'cascade'
      when 'r' then 'restrict'
      when 'n' then 'set null'
      when 'd' then 'set default'
      else 'no action'
    end;
    v_deferrable := case
      when r.condeferrable and r.condeferred then 'deferrable initially deferred'
      when r.condeferrable then 'deferrable initially immediate'
      else 'not deferrable'
    end;

    execute format('alter table public.%I drop constraint %I', r.child_name, r.conname);
    execute format(
      'alter table public.%I add constraint %I foreign key (tenant_id, %s) '
      'references public.%I (tenant_id, %s) on update %s on delete %s %s not valid',
      r.child_name, r.conname, v_child_cols,
      r.parent_name, v_parent_cols, v_on_update, v_on_delete, v_deferrable
    );
    begin
      execute format('alter table public.%I validate constraint %I', r.child_name, r.conname);
    exception when foreign_key_violation then
      raise warning 'multi-tenant 006: %.% has rows that cross tenants; left NOT VALID',
        r.child_name, r.conname;
    end;
  end loop;
end $$;

-- user_profiles.user_id: unique per tenant. The composite FKs above now use
-- (tenant_id, user_id), so the global key can go.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.user_profiles'::regclass
       and conname = 'user_profiles_tenant_id_user_id_key'
  ) then
    alter table public.user_profiles
      add constraint user_profiles_tenant_id_user_id_key unique (tenant_id, user_id);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.user_mcp_connector_tools'::regclass
       and conname = 'user_mcp_connector_tools_tenant_id_openai_tool_name_key'
  ) then
    alter table public.user_mcp_connector_tools
      add constraint user_mcp_connector_tools_tenant_id_openai_tool_name_key
      unique (tenant_id, openai_tool_name);
  end if;
end $$;
alter table public.user_profiles drop constraint if exists user_profiles_user_id_key;
alter table public.user_mcp_connector_tools
  drop constraint if exists user_mcp_connector_tools_openai_tool_name_key;

drop index if exists public.projects_external_provenance_key_unique;
create unique index projects_external_provenance_key_unique
  on public.projects (tenant_id, provenance_key)
  where project_kind = 'external_provenance';

drop index if exists public.projects_skill_library_provenance_unique;
create unique index projects_skill_library_provenance_unique
  on public.projects (tenant_id, provenance_key)
  where project_kind = 'skill_library';

drop index if exists public.db_jobs_dedupe_live_idx;
create unique index db_jobs_dedupe_live_idx
  on public.db_jobs (tenant_id, dedupe_key)
  where dedupe_key is not null and status in ('pending', 'running');

drop index if exists public.stream_runs_live_key;
create unique index stream_runs_live_key
  on public.stream_runs (tenant_id, run_key)
  where state in ('running', 'stopping');

-- Main's 0126 body (org departures, account_deletion_requested_at); only the
-- ON CONFLICT target changes (tenant_id from the default).
create or replace function public.request_account_erasure(
  p_user_id text, p_user_email text, p_provider text
)
returns uuid
language plpgsql
set search_path = public
as $$
declare v_id uuid;
begin
  if nullif(p_user_id, '') is null or p_provider not in ('entra','local','supabase') then
    raise exception 'invalid erasure request';
  end if;
  perform 1 from public.user_profiles where user_id::text=p_user_id for update;
  perform public.prepare_account_org_departures(p_user_id);
  update public.user_profiles set account_deletion_requested_at=coalesce(account_deletion_requested_at,now()) where user_id::text=p_user_id;
  insert into public.account_erasure_requests(user_id)
    values (p_user_id) on conflict (user_id) do nothing;
  update public.auth_sessions
     set revoked_at = coalesce(revoked_at, now()), version = version + 1,
         refresh_owner = null, refresh_lease_until = null
   where user_id = p_user_id and revoked_at is null;
  delete from public.auth_handoff_tickets where user_id = p_user_id;
  insert into public.db_jobs(kind,payload,dedupe_key,max_attempts)
    values ('account.delete', jsonb_build_object(
      'userId', p_user_id, 'userEmail', p_user_email, 'provider', p_provider),
      'account.delete:' || p_user_id, 20)
    on conflict (tenant_id, dedupe_key) where dedupe_key is not null
      and status in ('pending','running') do update set dedupe_key = excluded.dedupe_key
    returning id into v_id;
  return v_id;
end;
$$;

notify pgrst, 'reload schema';
