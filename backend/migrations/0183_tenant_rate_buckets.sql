-- Multi-tenant 017 (docs/issues/multi-tenant/017-shared-rate-limits-fair-queue.md):
-- shared per-tenant rate limits.
--
-- The express-rate-limit limiters in app.ts count per replica and per client
-- IP, so they neither span replicas nor know tenants. This adds a Postgres
-- token bucket per (tenant, bucket name), taken in one atomic
-- insert ... on conflict do update ... returning, so every backend replica
-- shares the same count. Redis only if this becomes a hotspot (README Q7).
--
-- - tenant_id comes from the column default (the request's PostgREST claim,
--   else the single-tenant install fallback; 0106), never from an argument.
--   RLS via app.enable_tenant_rls (0110).
-- - Buckets are named by the caller (backend/src/lib/rateLimit/
--   tenantBuckets.ts): requests (authenticated HTTP requests), llm-requests,
--   llm-tokens. Capacity and refill rate are arguments, so changing a limit
--   needs no migration; the backend leaves every limit off unless configured,
--   so single-tenant installs never call this.
-- - take_tenant_rate_tokens(bucket, cost, capacity, refill_per_second, force):
--     refill = min(capacity, tokens + elapsed * refill_per_second);
--     allowed when refill >= cost, then tokens = refill - cost;
--     force = true always debits (tokens may go negative) and reports allowed:
--     used to charge actual LLM tokens after a call, so the next call waits
--     until the debt is repaid (a cost-0 take is denied while tokens < 0).
--   Returns allowed, remaining tokens and the wait in ms until `cost` fits.

create table if not exists public.tenant_rate_buckets (
  tenant_id text not null default app.tenant_id_default()
    references public.tenants(tenant_id),
  bucket text not null check (length(bucket) between 1 and 64),
  tokens double precision not null,
  last_allowed boolean not null default true,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, bucket)
);

select app.enable_tenant_rls('public.tenant_rate_buckets');

revoke all on public.tenant_rate_buckets
  from public, web_anon, authenticated, service_role;
grant select, insert, update on public.tenant_rate_buckets to service_role;

create or replace function public.take_tenant_rate_tokens(
  p_bucket text,
  p_cost double precision,
  p_capacity double precision,
  p_refill_per_second double precision,
  p_force boolean default false
) returns table (allowed boolean, remaining double precision, retry_after_ms integer)
language sql
set search_path = ''
as $$
  insert into public.tenant_rate_buckets as b (bucket, tokens, last_allowed, updated_at)
  values (
    p_bucket,
    case when p_force or p_capacity >= p_cost then p_capacity - p_cost else p_capacity end,
    p_force or p_capacity >= p_cost,
    clock_timestamp()
  )
  on conflict (tenant_id, bucket) do update set
    tokens = case
      when p_force
        or least(p_capacity, b.tokens + greatest(0, extract(epoch from clock_timestamp() - b.updated_at)) * p_refill_per_second) >= p_cost
      then least(p_capacity, b.tokens + greatest(0, extract(epoch from clock_timestamp() - b.updated_at)) * p_refill_per_second) - p_cost
      else least(p_capacity, b.tokens + greatest(0, extract(epoch from clock_timestamp() - b.updated_at)) * p_refill_per_second)
    end,
    last_allowed = p_force
      or least(p_capacity, b.tokens + greatest(0, extract(epoch from clock_timestamp() - b.updated_at)) * p_refill_per_second) >= p_cost,
    updated_at = clock_timestamp()
  returning
    b.last_allowed,
    b.tokens,
    case
      when b.last_allowed then 0
      when p_refill_per_second <= 0 then 2147483647
      else least(2147483647, ceil((p_cost - b.tokens) / p_refill_per_second * 1000))::integer
    end;
$$;

revoke all on function public.take_tenant_rate_tokens(text, double precision, double precision, double precision, boolean)
  from public, web_anon, authenticated;
grant execute on function public.take_tenant_rate_tokens(text, double precision, double precision, double precision, boolean)
  to service_role;

notify pgrst, 'reload schema';
