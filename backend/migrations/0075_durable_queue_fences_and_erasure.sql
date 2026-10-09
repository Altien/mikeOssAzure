-- Queue claims have an immutable identity plus a renewable lease. All claim,
-- renewal and terminal transitions are single database statements.
alter table public.db_jobs
  add column if not exists lease_expires_at timestamptz;
alter table public.db_jobs
  add column if not exists claim_token uuid;
drop function if exists public.renew_db_job(uuid,integer,timestamptz,integer);
drop function if exists public.finish_db_job(uuid,integer,timestamptz,text,text,jsonb,timestamptz);

create or replace function public.claim_db_jobs(
  p_limit integer default 5,
  p_stale_seconds integer default 600
)
returns setof public.db_jobs
language sql
as $$
  with abandoned as (
    update public.db_jobs
       set status = 'failed', finished_at = now(), lease_expires_at = null,
           last_error = coalesce(last_error, 'abandoned: attempt budget exhausted')
     where status = 'running'
       and coalesce(lease_expires_at, claimed_at + make_interval(secs => p_stale_seconds)) < now()
       and attempts >= max_attempts
    returning id
  ), candidates as (
    select id from public.db_jobs
     where (status = 'pending' and run_at <= now() and attempts < max_attempts)
        or (status = 'running' and
            coalesce(lease_expires_at, claimed_at + make_interval(secs => p_stale_seconds)) < now()
            and attempts < max_attempts)
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
returns setof public.db_jobs
language sql
as $$
  update public.db_jobs j
     set status = 'running', claimed_at = now(), claim_token = gen_random_uuid(),
         lease_expires_at = now() + make_interval(secs => p_stale_seconds),
         attempts = j.attempts + 1
   where j.id = p_id and j.attempts < j.max_attempts
     and ((j.status = 'pending' and j.run_at <= now())
       or (j.status = 'running' and
           coalesce(j.lease_expires_at, j.claimed_at + make_interval(secs => p_stale_seconds)) < now()))
  returning j.*;
$$;

create or replace function public.renew_db_job(
  p_id uuid, p_attempts integer, p_claim_token uuid,
  p_lease_seconds integer default 600
)
returns boolean
language sql
as $$
  with renewed as (
    update public.db_jobs
       set lease_expires_at = now() + make_interval(secs => p_lease_seconds)
     where id = p_id and status = 'running' and attempts = p_attempts
       and claim_token = p_claim_token and lease_expires_at > now()
    returning 1
  ) select exists(select 1 from renewed);
$$;

create or replace function public.finish_db_job(
  p_id uuid, p_attempts integer, p_claim_token uuid,
  p_status text, p_last_error text default null, p_result jsonb default null,
  p_run_at timestamptz default null
)
returns boolean
language plpgsql
as $$
declare v_count integer;
begin
  if p_status not in ('done', 'pending', 'failed') then
    raise exception 'invalid job terminal status';
  end if;
  update public.db_jobs
     set status = p_status,
         lease_expires_at = null,
         finished_at = case when p_status = 'pending' then null else now() end,
         run_at = case when p_status = 'pending' then coalesce(p_run_at, now()) else run_at end,
         last_error = p_last_error,
         result = case when p_result is null then result else p_result end
   where id = p_id and status = 'running' and attempts = p_attempts
     and claim_token = p_claim_token and lease_expires_at > now();
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

revoke execute on function public.claim_db_jobs(integer,integer),
  public.claim_db_job(uuid,integer),
  public.renew_db_job(uuid,integer,uuid,integer),
  public.finish_db_job(uuid,integer,uuid,text,text,jsonb,timestamptz)
  from public, web_anon, authenticated;
grant execute on function public.claim_db_jobs(integer,integer),
  public.claim_db_job(uuid,integer),
  public.renew_db_job(uuid,integer,uuid,integer),
  public.finish_db_job(uuid,integer,uuid,text,text,jsonb,timestamptz)
  to service_role;

-- A tombstone survives erasure so already-issued Entra bearer credentials
-- cannot silently recreate the profile and data after the worker finishes.
create table if not exists public.account_erasure_requests (
  user_id text primary key,
  status text not null default 'requested' check (status in ('requested','complete')),
  requested_at timestamptz not null default now(),
  completed_at timestamptz
);
revoke all on public.account_erasure_requests from public, web_anon, authenticated;
grant select, insert, update on public.account_erasure_requests to service_role;

create or replace function public.request_account_erasure(
  p_user_id text, p_user_email text, p_provider text
)
returns uuid
language plpgsql
as $$
declare v_id uuid;
begin
  if nullif(p_user_id, '') is null or p_provider not in ('entra','local','supabase') then
    raise exception 'invalid erasure request';
  end if;
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
    on conflict (dedupe_key) where dedupe_key is not null
      and status in ('pending','running') do update set dedupe_key = excluded.dedupe_key
    returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.complete_account_erasure(p_user_id text)
returns boolean
language sql
as $$
  with completed as (
    update public.account_erasure_requests
       set status = 'complete', completed_at = coalesce(completed_at, now())
     where user_id = p_user_id
    returning 1
  ) select exists(select 1 from completed);
$$;

revoke execute on function public.request_account_erasure(text,text,text),
  public.complete_account_erasure(text) from public, web_anon, authenticated;
grant execute on function public.request_account_erasure(text,text,text),
  public.complete_account_erasure(text) to service_role;

-- This trigger writes cleanup intent in the same transaction that removes the
-- last DB pointer. A process crash or enqueue network failure cannot orphan
-- document or workflow-reference blobs after a successful row deletion.
create or replace function public.queue_deleted_storage_paths()
returns trigger language plpgsql as $$
declare v_keys text[] := array[]::text[];
begin
  if tg_op = 'DELETE' then
    if tg_table_name = 'document_versions' then
      v_keys := array_append(v_keys, 'extracted-text/' || old.id::text || '.txt');
      if old.pdf_storage_path is not null then
        v_keys := array_append(v_keys, old.pdf_storage_path);
      end if;
    end if;
    if old.storage_path is not null then
      v_keys := array_append(v_keys, old.storage_path);
    end if;
  elsif tg_table_name = 'document_versions' then
    if old.storage_path is distinct from new.storage_path and old.storage_path is not null then
      v_keys := array_append(v_keys, old.storage_path);
    end if;
    if old.pdf_storage_path is distinct from new.pdf_storage_path and old.pdf_storage_path is not null then
      v_keys := array_append(v_keys, old.pdf_storage_path);
    end if;
  elsif old.storage_path is distinct from new.storage_path and old.storage_path is not null then
    v_keys := array_append(v_keys, old.storage_path);
  end if;
  if cardinality(v_keys) > 0 then
    insert into public.db_jobs(kind,payload,max_attempts)
      values ('storage.cleanup', jsonb_build_object('keys', to_jsonb(v_keys)), 100);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists document_versions_storage_cleanup on public.document_versions;
create trigger document_versions_storage_cleanup
  after delete or update of storage_path, pdf_storage_path on public.document_versions
  for each row execute function public.queue_deleted_storage_paths();
drop trigger if exists workflow_reference_storage_cleanup on public.workflow_reference_documents;
create trigger workflow_reference_storage_cleanup
  after delete or update of storage_path on public.workflow_reference_documents
  for each row execute function public.queue_deleted_storage_paths();
drop trigger if exists workflow_addon_storage_cleanup on public.workflow_addon_reference_files;
create trigger workflow_addon_storage_cleanup
  after delete or update of storage_path on public.workflow_addon_reference_files
  for each row execute function public.queue_deleted_storage_paths();
