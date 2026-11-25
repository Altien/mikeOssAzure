-- Migration date: 2026-11-01
-- Upstream: 20261101_24_wipe_memory_files_batch.sql (sync-log: 2e3ea04d).
-- Dev divergence: Dev's wipe_memory_file (0092) takes and returns the actor
-- as text (p_updated_by, mutation_by), so the batch form does too; anon is
-- Dev's web_anon. Multi-tenant (0180): like wipe_memory_file it is owned
-- by tenant_definer (a security definer function must not be owned by an
-- RLS-bypassing role; app.tenant_rls_gaps() flags it otherwise), so it sees
-- only the caller's tenant, and tenant_app (the request client) may execute
-- it alongside service_role.
-- Batch form of wipe_memory_file for erasure loops (account and
-- organization deletion), one round trip instead of one per file. Each id
-- is wiped by wipe_memory_file itself, so locking, epoch/revision fencing,
-- validation and errors are identical; ids are taken once each, in id
-- order, so concurrent batches lock rows in the same order. The whole batch
-- is one transaction: a missing id (memory_file_not_found, P0002) or an
-- invalid source (22023) rolls back every wipe in it.
create or replace function public.wipe_memory_files(
  p_ids uuid[],
  p_enabled boolean,
  p_updated_by text default null,
  p_source text default 'wipe'
)
returns table(
  memory_file_id uuid,
  new_epoch bigint,
  new_revision bigint,
  effective_enabled boolean,
  mutation_at timestamptz,
  mutation_by text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  file_id uuid;
begin
  if p_source is null or p_source not in ('wipe', 'settings') then
    raise exception using errcode = '22023', message = 'invalid_memory_source';
  end if;
  for file_id in
    select distinct requested.id from unnest(coalesce(p_ids, '{}'::uuid[])) requested(id)
    order by requested.id
  loop
    return query
      select file_id, wiped.new_epoch, wiped.new_revision, wiped.effective_enabled,
        wiped.mutation_at, wiped.mutation_by
      from public.wipe_memory_file(file_id, p_enabled, p_updated_by, p_source) wiped;
  end loop;
end;
$$;
revoke all on function public.wipe_memory_files(uuid[], boolean, text, text)
  from public, web_anon, authenticated;
-- A non-superuser migrator (Azure) can re-own only to a role holding CREATE
-- on the schema; grant it for the change and restore it (0199 pattern).
do $$ declare v_had boolean := has_schema_privilege('tenant_definer', 'public', 'CREATE'); begin
  grant create on schema public to tenant_definer;
  alter function public.wipe_memory_files(uuid[], boolean, text, text)
    owner to tenant_definer;
  if not v_had then revoke create on schema public from tenant_definer; end if;
end $$;
grant execute on function public.wipe_memory_files(uuid[], boolean, text, text)
  to tenant_app, service_role;
