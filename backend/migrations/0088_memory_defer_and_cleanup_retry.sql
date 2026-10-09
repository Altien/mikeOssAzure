-- Quiet-period memory deferrals do not spend attempts. Storage cleanup keeps
-- retrying until it succeeds, while both transitions retain the claim fence.
create or replace function public.defer_db_job(
  p_id uuid, p_attempts integer, p_claim_token uuid,
  p_run_at timestamptz, p_reason text
)
returns boolean language plpgsql as $$
declare changed integer;
begin
  update public.db_jobs
     set status = 'pending', attempts = greatest(attempts - 1, 0),
         claimed_at = null, claim_token = null, lease_expires_at = null,
         finished_at = null, run_at = greatest(p_run_at, now()),
         last_error = p_reason
   where id = p_id and status = 'running' and attempts = p_attempts
     and claim_token = p_claim_token and lease_expires_at > now();
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

create or replace function public.claim_db_jobs(
  p_limit integer default 5, p_stale_seconds integer default 600
)
returns setof public.db_jobs language sql as $$
  with abandoned as (
    update public.db_jobs
       set status = 'failed', finished_at = now(), lease_expires_at = null,
           last_error = coalesce(last_error, 'abandoned: attempt budget exhausted')
     where status = 'running' and kind <> 'storage.cleanup'
       and coalesce(lease_expires_at, claimed_at + make_interval(secs => p_stale_seconds)) < now()
       and attempts >= max_attempts
    returning id
  ), candidates as (
    select id from public.db_jobs
     where (status = 'pending' and run_at <= now()
            and (attempts < max_attempts or kind = 'storage.cleanup'))
        or (status = 'running' and
            coalesce(lease_expires_at, claimed_at + make_interval(secs => p_stale_seconds)) < now()
            and (attempts < max_attempts or kind = 'storage.cleanup'))
     order by run_at
     limit greatest(0, least(p_limit, 100))
     for update skip locked
  )
  update public.db_jobs j
     set status = 'running', claimed_at = now(), claim_token = gen_random_uuid(),
         lease_expires_at = now() + make_interval(secs => p_stale_seconds),
         attempts = j.attempts + 1
    from candidates c where j.id = c.id
  returning j.*;
$$;

create or replace function public.claim_db_job(
  p_id uuid, p_stale_seconds integer default 600
)
returns setof public.db_jobs language sql as $$
  update public.db_jobs j
     set status = 'running', claimed_at = now(), claim_token = gen_random_uuid(),
         lease_expires_at = now() + make_interval(secs => p_stale_seconds),
         attempts = j.attempts + 1
   where j.id = p_id and (j.attempts < j.max_attempts or j.kind = 'storage.cleanup')
     and ((j.status = 'pending' and j.run_at <= now())
       or (j.status = 'running' and
           coalesce(j.lease_expires_at, j.claimed_at + make_interval(secs => p_stale_seconds)) < now()))
  returning j.*;
$$;

revoke execute on function public.defer_db_job(uuid,integer,uuid,timestamptz,text),
  public.claim_db_jobs(integer,integer), public.claim_db_job(uuid,integer)
  from public, web_anon, authenticated;
grant execute on function public.defer_db_job(uuid,integer,uuid,timestamptz,text),
  public.claim_db_jobs(integer,integer), public.claim_db_job(uuid,integer)
  to service_role;
