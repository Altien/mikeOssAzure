-- Kind-scoped lifecycle cleanup claims, composed with Dev's durable lease and
-- claim-token fences from 0075/0088. Never replace them with source's unfenced
-- queue functions. Repeatable during rolling upgrades.
begin;
create index if not exists db_jobs_pending_kind_idx
  on public.db_jobs(kind, run_at) where status = 'pending';
create index if not exists db_jobs_failed_cleanup_run_at_idx
  on public.db_jobs(run_at) where status = 'failed'
  and kind in ('storage.cleanup', 'document.cleanup');

-- Avoid a defaulted 3-argument overload competing with the 2-argument RPC.
drop function if exists public.claim_db_jobs(integer, integer);
create or replace function public.claim_db_jobs(
  p_limit integer default 5, p_stale_seconds integer default 600,
  p_kind text default null
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
  ), candidates as (
    select id from public.db_jobs
     where (p_kind is null or kind = p_kind)
       and ((status = 'pending' and run_at <= now()
             and (attempts < max_attempts or kind in ('storage.cleanup', 'document.cleanup')))
         or (status = 'failed' and kind in ('storage.cleanup', 'document.cleanup')
             and run_at <= now())
         or (status = 'running'
             and coalesce(lease_expires_at, claimed_at + make_interval(secs => p_stale_seconds)) < now()
             and (attempts < max_attempts or kind in ('storage.cleanup', 'document.cleanup'))))
     order by run_at
     limit greatest(0, least(p_limit, 100)) for update skip locked
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
revoke all on function public.claim_db_jobs(integer,integer,text)
  from public,web_anon,authenticated;
grant execute on function public.claim_db_jobs(integer,integer,text)
  to service_role;

create or replace function public.claim_db_job(
  p_id uuid, p_stale_seconds integer default 600
) returns setof public.db_jobs language sql set search_path = '' as $$
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
   where j.id = p_id
     and ((j.status = 'pending' and j.run_at <= now()
           and (j.attempts < j.max_attempts or j.kind in ('storage.cleanup', 'document.cleanup')))
       or (j.status = 'failed' and j.kind in ('storage.cleanup', 'document.cleanup')
           and j.run_at <= now())
       or (j.status = 'running'
           and coalesce(j.lease_expires_at, j.claimed_at + make_interval(secs => p_stale_seconds)) < now()
           and (j.attempts < j.max_attempts or j.kind in ('storage.cleanup', 'document.cleanup'))))
  returning j.*;
$$;
revoke all on function public.claim_db_job(uuid,integer)
  from public,web_anon,authenticated;
grant execute on function public.claim_db_job(uuid,integer) to service_role;
commit;
notify pgrst, 'reload schema';
