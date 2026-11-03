-- Multi-tenant 017 (docs/issues/multi-tenant/017-shared-rate-limits-fair-queue.md):
-- fair job claiming across tenants.
--
-- claim_db_jobs (0090) claimed in one global FIFO (order by run_at), so a
-- tenant that enqueued 1,000 jobs held every worker until its backlog drained.
-- It now picks round-robin across tenants with ready jobs: every tenant's
-- oldest ready job ranks before any tenant's second, ties broken by run_at.
-- With a single tenant (or rows whose tenant_id is null before 005) that is
-- exactly the old run_at order.
--
-- p_tenant_cap (new, default null = no cap) bounds how many live (running,
-- unexpired lease) jobs one tenant may hold across all workers and replicas;
-- a tenant at its cap is skipped for this claim. The backend passes it only
-- when DBQ_TENANT_CONCURRENCY is set (backend/src/lib/dbq/runner.ts).
--
-- Everything else is 0090's body unchanged: the abandoned sweep, the ready
-- predicate (cleanup kinds retry forever) and the claim update. Still an
-- invoker function claimed through the platform client (004), granted to
-- service_role only. The extra parameter changes the signature, so the
-- 3-argument version is dropped first.

create index if not exists db_jobs_tenant_running_idx
  on public.db_jobs (tenant_id, lease_expires_at)
  where status = 'running';

drop function if exists public.claim_db_jobs(integer, integer, text);
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
    select id, tenant_id, run_at from public.db_jobs
     where (p_kind is null or kind = p_kind)
       and ((status = 'pending' and run_at <= now()
             and (attempts < max_attempts or kind in ('storage.cleanup', 'document.cleanup')))
         or (status = 'failed' and kind in ('storage.cleanup', 'document.cleanup')
             and run_at <= now())
         or (status = 'running'
             and coalesce(lease_expires_at, claimed_at + make_interval(secs => p_stale_seconds)) < now()
             and (attempts < max_attempts or kind in ('storage.cleanup', 'document.cleanup'))))
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
    from candidates c where j.id = c.id
  returning j.*;
$$;
revoke all on function public.claim_db_jobs(integer,integer,text,integer)
  from public,web_anon,authenticated;
grant execute on function public.claim_db_jobs(integer,integer,text,integer)
  to service_role;

notify pgrst, 'reload schema';
