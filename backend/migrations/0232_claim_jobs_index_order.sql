-- Migration date: 2026-11-01
-- Upstream: 20261101_14_claim_jobs_index_order.sql (sync-log: 20c5a305).
-- Built on Dev's 0184 fair-share claim_db_jobs (4-arg, tenant cap, lease
-- columns, claim token); signature and grants carry over. Adopted: the
-- claimable conditions as disjoint UNION ALL arms (one partial index each)
-- and the final update's primary-key probe. Not adopted: upstream's per-arm
-- LIMIT/lock (see the divergence note in the body).
-- claim_db_jobs ORed its three claim paths (due pending, revivable failed
-- cleanup, stale running), which no partial index can serve, and the final
-- update hash-joined the whole table. Each path now reads its own partial
-- index; the update probes the claimed ids by primary key. Same rows
-- claimed, same updates applied.
create or replace function public.claim_db_jobs(
  p_limit integer default 5, p_stale_seconds integer default 600,
  p_kind text default null, p_tenant_cap integer default null
) returns setof public.db_jobs language sql set search_path = '' as $$
  with abandoned as (
    update public.db_jobs
       set status = 'failed', finished_at = now(), lease_expires_at = null,
           claim_token = null,
           last_error = coalesce(last_error, 'abandoned: attempt budget exhausted')
     where status = 'running'
       and kind not in ('storage.cleanup', 'document.cleanup')
       and coalesce(lease_expires_at, claimed_at + make_interval(secs => p_stale_seconds)) < now()
       and attempts >= max_attempts
    returning id
  ), ready as (
    -- One arm per way a row can be claimable, each served by its own
    -- partial index (pending, pending by kind, failed cleanup, running).
    -- Arms are disjoint (by status, and by whether p_kind is given; that
    -- test is a one-time filter). A single OR of the conditions could use no
    -- partial index.
    -- Upstream divergence (sync-log: 20c5a305): upstream also stops each arm
    -- at p_limit rows in run_at order and locks inside the arms. Dev's 0184
    -- fair claim ranks every due row per tenant (round-robin turns and the
    -- p_tenant_cap headroom) before picking, so a per-arm LIMIT would let one
    -- tenant's backlog crowd every other tenant out of the page. Keep the
    -- arms unlimited and the lock on the picked ids (candidates below).
    select id, tenant_id, run_at from public.db_jobs
     where p_kind is null and status = 'pending' and run_at <= now()
       and (attempts < max_attempts or kind in ('storage.cleanup', 'document.cleanup'))
    union all
    select id, tenant_id, run_at from public.db_jobs
     where kind = p_kind and status = 'pending' and run_at <= now()
       and (attempts < max_attempts or kind in ('storage.cleanup', 'document.cleanup'))
    union all
    -- Cleanup intents are retried forever, but politely: a revived
    -- `failed` row waits for its own run_at like everything else.
    select id, tenant_id, run_at from public.db_jobs
     where status = 'failed' and kind in ('storage.cleanup', 'document.cleanup')
       and run_at <= now()
       and (p_kind is null or kind = p_kind)
    union all
    select id, tenant_id, run_at from public.db_jobs
     where status = 'running'
       and coalesce(lease_expires_at, claimed_at + make_interval(secs => p_stale_seconds)) < now()
       and (attempts < max_attempts or kind in ('storage.cleanup', 'document.cleanup'))
       and (p_kind is null or kind = p_kind)
  ), live as (
    select tenant_id, count(*) as running from public.db_jobs
     where p_tenant_cap is not null
       and status = 'running'
       and coalesce(lease_expires_at, claimed_at + make_interval(secs => p_stale_seconds)) >= now()
     group by tenant_id
  ), ranked as (
    select r.id, r.run_at,
           row_number() over (partition by r.tenant_id order by r.run_at, r.id) as turn,
           coalesce(l.running, 0) as running
      from ready r
      left join live l on l.tenant_id is not distinct from r.tenant_id
  ), picked as (
    select id from ranked
     where p_tenant_cap is null or turn <= p_tenant_cap - running
     order by turn, run_at, id
     limit greatest(0, least(p_limit, 100))
  ), candidates as (
    select id from public.db_jobs
     where id in (select id from picked)
     for update skip locked
  )
  update public.db_jobs j
     set status = 'running', claimed_at = now(), finished_at = null,
         claim_token = gen_random_uuid(),
         lease_expires_at = now() + make_interval(secs => p_stale_seconds),
         attempts = case when j.kind in ('storage.cleanup', 'document.cleanup')
           then least(j.attempts::bigint + 1, 2147483647)::integer
           else j.attempts + 1 end,
         max_attempts = case when j.kind in ('storage.cleanup', 'document.cleanup')
           then 2147483647 else j.max_attempts end,
         run_at = case when j.status = 'failed'
           and j.kind in ('storage.cleanup', 'document.cleanup')
           then now() + least(interval '10 minutes',
             make_interval(secs => 30 * least(j.attempts::bigint + 1, 20)))
           else j.run_at end,
         dedupe_key = case when j.status = 'failed'
           and j.kind in ('storage.cleanup', 'document.cleanup')
           then null else j.dedupe_key end
   -- Primary-key probes for the few claimed ids. A join to the CTE is
   -- planned without knowing p_limit and hash-joined the whole table.
   where j.id = any (array(select id from candidates))
  returning j.*;
$$;
