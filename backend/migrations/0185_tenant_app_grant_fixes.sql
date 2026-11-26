-- Multi-tenant follow-up to 015/017 (docs/issues/multi-tenant/HANDOFF.md
-- "Post-merge cross-checks"): two grant bugs found after the track merge —
-- one silently disables the new rate limits, the other lets a tenant rewrite
-- its own usage ledger.
--
--   a. public.take_tenant_rate_tokens (0116) is called through the request
--      client (tenant_app), but 0116 granted execute to service_role only.
--      Functions created after 0110 get no tenant_app execute: 0110's
--      blanket grant ran once over the functions that existed then, and its
--      default privileges cover tables and sequences only. Without the
--      grant the RPC fails 42501 and the limiter fails OPEN — every enabled
--      limit would allow every request.
--   b. tenant_app inherits full DML on llm_usage_events (and each partition)
--      from 0110's default privileges, so it could update or delete its own
--      ledger rows. The ledger is append-only: keep select, insert on the
--      parent; revoke update, delete there and revoke all on every
--      partition (rows are read and written only through the parent, whose
--      policy applies — PostgREST would otherwise expose each partition as
--      a table of its own).
--   c. app.ensure_llm_usage_partitions (0115) created partitions with no
--      RLS and no tenant_app revoke. 0110's gate (and the 009 canary)
--      checks every public table — partitions included — for forced RLS +
--      tenant_isolation, so a partition created later would fail the gate.
--      The function now calls app.enable_tenant_rls and revokes tenant_app
--      on each partition it creates.
--
-- 0115–0117 stay untouched: another database may already carry them. This
-- migration is idempotent; the gate re-check at the end fails the migration
-- if any gap is left.

grant execute on function public.take_tenant_rate_tokens(
  text, double precision, double precision, double precision, boolean
) to tenant_app;

revoke update, delete on public.llm_usage_events from tenant_app;

do $$
declare
  r record;
begin
  for r in
    select t.relid::regclass as part
      from pg_partition_tree('public.llm_usage_events'::regclass) t
     where t.relid <> 'public.llm_usage_events'::regclass
  loop
    execute format('revoke all on %s from tenant_app', r.part);
  end loop;
end
$$;

create or replace function app.ensure_llm_usage_partitions(
  p_from date, p_months integer
) returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_start date := date_trunc('month', p_from)::date;
  v_created integer := 0;
  v_name text;
begin
  for i in 0 .. greatest(p_months, 1) - 1 loop
    v_name := format('llm_usage_events_y%sm%s',
      to_char(v_start + make_interval(months => i), 'YYYY'),
      to_char(v_start + make_interval(months => i), 'MM'));
    if to_regclass(format('public.%I', v_name)) is null then
      execute format(
        'create table public.%I partition of public.llm_usage_events '
        || 'for values from (%L) to (%L)',
        v_name,
        (v_start + make_interval(months => i))::timestamptz,
        (v_start + make_interval(months => i + 1))::timestamptz);
      -- Partitions carry no grants at all: rows are reached only through
      -- the parent, whose privileges and policy apply.
      execute format('revoke all on public.%I from public, web_anon, authenticated, service_role', v_name);
      if exists (select 1 from pg_catalog.pg_roles where rolname = 'tenant_definer') then
        execute format('revoke all on public.%I from tenant_definer', v_name);
      end if;
      if exists (select 1 from pg_catalog.pg_roles where rolname = 'tenant_app') then
        execute format('revoke all on public.%I from tenant_app', v_name);
      end if;
      -- A partition is a table of its own: forced RLS + tenant_isolation
      -- (and the migration gate) apply to it directly, not only via the
      -- parent.
      perform app.enable_tenant_rls(format('public.%I', v_name)::regclass);
      v_created := v_created + 1;
    end if;
  end loop;
  return v_created;
end
$$;

-- Same gate 0110 ends with: fail the migration if anything is left open.
do $$
declare
  v_gaps text;
begin
  select string_agg(object || ': ' || problem, '; ') into v_gaps
    from app.tenant_rls_gaps();
  if v_gaps is not null then
    raise exception 'multi-tenant 015/017 fix: tenant RLS gaps: %', v_gaps;
  end if;
end
$$;

notify pgrst, 'reload schema';
