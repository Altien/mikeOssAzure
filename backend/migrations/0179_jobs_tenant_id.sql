-- Multi-tenant phase 1, issue 003 (docs/issues/multi-tenant/003-jobs-carry-tenant.md):
-- background work carries the tenant that queued it.
--
-- db_jobs, upload_processing_jobs and stream_runs get a tenant_id that the
-- database fills from the request's PostgREST JWT claim (issue 002), so no
-- enqueue call site changes. The worker runner claims with the platform client
-- and runs each handler inside that tenant's context.
--
-- Safe before or after the schema migrations of issue 005 (0106 adds
-- `tenant_id text not null default app.tenant_id_default() references
-- tenants`). On a database where the column already exists this file changes
-- NOTHING about it:
--   - `add column if not exists`: an existing column, its NOT NULL and its
--     default are kept; the default below applies only when this file creates
--     the column. There is deliberately no `alter column ... set default`.
--   - the foreign key is added only if the table has none to tenants yet.
--   - the backfill touches only NULL rows (none under 0106's NOT NULL).
--
-- When this file creates the column (issue 005 not yet applied):
--   - nullable: rows queued outside a request (platform sweeps, SQL run
--     without claims) keep NULL and the runner falls back to the install's
--     tenant. Issue 005 makes it NOT NULL.
--   - the claim is read as current_setting('request.jwt.claims', true)::jsonb
--     ->> 'tenant_id', with an empty setting treated as no claim: once a
--     session has used set_config on the claim (raw pg: StreamRunCluster,
--     migrations) current_setting returns '' rather than NULL, and ''::jsonb
--     raises. The default must never break an insert.
--   - backfill with the install's tenant only when exactly one tenants row
--     exists (every single-tenant install that has signed in). Otherwise rows
--     stay NULL; the runtime fallback covers them.

do $$
declare
  t text;
begin
  foreach t in array array['db_jobs', 'upload_processing_jobs', 'stream_runs'] loop
    execute format(
      'alter table public.%I add column if not exists tenant_id text default '
      || '(nullif(current_setting(''request.jwt.claims'', true), '''')::jsonb ->> ''tenant_id'')',
      t);
    if not exists (
      select 1
      from pg_constraint
      where conrelid = format('public.%I', t)::regclass
        and confrelid = 'public.tenants'::regclass
        and contype = 'f'
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (tenant_id) references public.tenants(tenant_id)',
        t, t || '_tenant_id_fkey');
    end if;
    execute format(
      'update public.%I set tenant_id = (select tenant_id from public.tenants) '
      || 'where tenant_id is null and (select count(*) from public.tenants) = 1',
      t);
  end loop;
end
$$;
