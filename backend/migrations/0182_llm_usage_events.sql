-- Multi-tenant 015 (docs/issues/multi-tenant/015-llm-usage-ledger.md):
-- record every LLM call in an append-only usage ledger.
--
-- Design: docs/multi-tenant/003-target-architecture.md section 5 ("Meter
-- inside the app"). The backend writes one row per logical model call
-- (backend/src/lib/llm/usage.ts, wrapped around streamWithProvider and
-- completeWithProvider): tool-loop steps and reasoning-level retries are
-- summed into the call's row; aborted and failed calls are recorded with what
-- was produced.
--
-- - tenant_id comes from the column default (the request's PostgREST tenant
--   claim, else the single-tenant install fallback; 0106), never from the
--   caller. RLS via app.enable_tenant_rls (0110).
-- - Partitioned by month on created_at. Partitions for the current month and
--   the next 24 are created here; a default partition catches anything later,
--   so an insert never fails for want of a partition. A later migration (or
--   the stamp runtime, 019) calls app.ensure_llm_usage_partitions to extend
--   the range. Partitions carry no grants: rows are read and written only
--   through the parent, whose policies apply.
-- - Append-only: service_role may insert and select, never update or delete.
--   Retention and roll-ups are the control plane's (018).
-- - price_table_version is null until issue 016 introduces the price table.
-- - user_id is the acting user's text id, deliberately without a foreign key:
--   the ledger is a billing record and outlives the profile row.
-- - public.llm_usage_daily: per-tenant daily aggregate for admins and the
--   control plane (security_invoker, so it honours the caller's RLS).

create table if not exists public.llm_usage_events (
  id bigint generated always as identity,
  tenant_id text not null default app.tenant_id_default()
    references public.tenants(tenant_id),
  created_at timestamptz not null default now(),
  user_id text,
  request_id text,
  feature text not null,
  provider text not null,
  model text not null,
  key_mode text not null default 'platform'
    check (key_mode in ('platform', 'byo')),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cache_read_tokens bigint not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens bigint not null default 0 check (cache_write_tokens >= 0),
  steps integer not null default 0 check (steps >= 0),
  usage_estimated boolean not null default false,
  outcome text not null check (outcome in ('completed', 'aborted', 'failed')),
  latency_ms integer not null default 0 check (latency_ms >= 0),
  provider_response_id text,
  price_table_version text,
  primary key (id, created_at)
) partition by range (created_at);

create index if not exists llm_usage_events_tenant_created_idx
  on public.llm_usage_events (tenant_id, created_at);

create table if not exists public.llm_usage_events_default
  partition of public.llm_usage_events default;

-- Create the monthly partitions covering [p_from's month, + p_months).
-- Invoker rights: only the table owner (the migration user) can run it.
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
      execute format('revoke all on public.%I from public, web_anon, authenticated, service_role', v_name);
      if exists (select 1 from pg_catalog.pg_roles where rolname = 'tenant_definer') then
        execute format('revoke all on public.%I from tenant_definer', v_name);
      end if;
      v_created := v_created + 1;
    end if;
  end loop;
  return v_created;
end
$$;

revoke all on function app.ensure_llm_usage_partitions(date, integer)
  from public, web_anon, authenticated, service_role;

select app.ensure_llm_usage_partitions(current_date, 25);

revoke all on public.llm_usage_events_default
  from public, web_anon, authenticated, service_role;

select app.enable_tenant_rls('public.llm_usage_events');

-- service_role holds default privileges on new tables (earlier migrations);
-- revoke them so only select and insert remain.
revoke all on public.llm_usage_events
  from public, web_anon, authenticated, service_role;
grant select, insert on public.llm_usage_events to service_role;
-- 0108's default privileges give tenant_definer full rights on new tables;
-- the ledger stays append-only for definer functions too.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'tenant_definer') then
    revoke update, delete on public.llm_usage_events from tenant_definer;
    revoke all on public.llm_usage_events_default from tenant_definer;
  end if;
end
$$;

create or replace view public.llm_usage_daily
with (security_invoker = true) as
select
  tenant_id,
  (created_at at time zone 'UTC')::date as usage_date,
  feature,
  provider,
  model,
  key_mode,
  count(*) as calls,
  count(*) filter (where outcome = 'aborted') as aborted_calls,
  count(*) filter (where outcome = 'failed') as failed_calls,
  count(*) filter (where usage_estimated) as estimated_calls,
  sum(input_tokens) as input_tokens,
  sum(output_tokens) as output_tokens,
  sum(cache_read_tokens) as cache_read_tokens,
  sum(cache_write_tokens) as cache_write_tokens
from public.llm_usage_events
group by tenant_id, (created_at at time zone 'UTC')::date,
  feature, provider, model, key_mode;

revoke all on public.llm_usage_daily
  from public, web_anon, authenticated, service_role;
grant select on public.llm_usage_daily to service_role;

notify pgrst, 'reload schema';
