-- Private Blob transfer receipts and exact verification claims. Both owner
-- checks and state transitions run under row locks in private PostgREST.
begin;

create or replace function public.claim_upload_part(
  p_session_id uuid, p_file_id uuid, p_user_id text,
  p_generation uuid, p_part_index integer, p_size integer
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  f record;
  receipt record;
  expected integer;
  token uuid := gen_random_uuid();
begin
  select f0.*, s.user_id as owner_id, s.status as session_status, s.expires_at
    into f
    from public.upload_session_files f0
    join public.upload_sessions s on s.id = f0.session_id
   where f0.id = p_file_id and f0.session_id = p_session_id
   for update of f0, s;
  if not found or f.owner_id <> p_user_id or f.session_status not in ('pending_upload','verifying','uploaded','processing')
     or f.status <> 'pending_upload' or f.expires_at <= now()
     or f.upload_transport <> 'authenticated_parts'
     or f.upload_generation <> p_generation then
    raise exception using errcode = 'P0001', message = 'upload_part_not_allowed';
  end if;
  if p_part_index < 0 or p_part_index > 12 then
    raise exception using errcode = '22023', message = 'upload_part_index_invalid';
  end if;
  expected := least(8388608::bigint, f.expected_size_bytes - p_part_index::bigint * 8388608)::integer;
  if expected < 1 or p_size <> expected then
    raise exception using errcode = '22023', message = 'upload_part_size_invalid';
  end if;
  select * into receipt from public.upload_session_parts
   where file_id = p_file_id and generation = p_generation and part_index = p_part_index
   for update;
  if found and receipt.status = 'completed' then
    return jsonb_build_object('status', 'completed');
  end if;
  if found and receipt.claimed_at > now() - interval '5 minutes' then
    return jsonb_build_object('status', 'busy');
  end if;
  insert into public.upload_session_parts
    (file_id, generation, part_index, size_bytes, status, claim_token, claimed_at, completed_at)
  values (p_file_id, p_generation, p_part_index, p_size, 'processing', token, now(), null)
  on conflict (file_id, generation, part_index) do update
    set status = 'processing', claim_token = excluded.claim_token,
        claimed_at = now(), completed_at = null;
  return jsonb_build_object('status', 'claimed', 'claim_token', token);
end;
$$;

create or replace function public.complete_upload_part(
  p_session_id uuid, p_file_id uuid, p_user_id text,
  p_generation uuid, p_part_index integer, p_claim_token uuid
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare f record;
begin
  select f0.id, f0.upload_generation, f0.status, s.user_id, s.status as session_status, s.expires_at
    into f from public.upload_session_files f0
    join public.upload_sessions s on s.id = f0.session_id
   where f0.id = p_file_id and f0.session_id = p_session_id
   for update of f0, s;
  if not found or f.user_id <> p_user_id or f.upload_generation <> p_generation
     or f.status <> 'pending_upload' or f.session_status not in ('pending_upload','verifying','uploaded','processing')
     or f.expires_at <= now() then return false; end if;
  update public.upload_session_parts set status = 'completed', completed_at = now()
   where file_id = p_file_id and generation = p_generation
     and part_index = p_part_index and status = 'processing'
     and claim_token = p_claim_token and claimed_at > now() - interval '5 minutes';
  return found;
end;
$$;

create or replace function public.claim_upload_verification(
  p_session_id uuid, p_file_id uuid, p_user_id text
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare f record; token uuid := gen_random_uuid(); expected_parts integer; completed_parts integer;
begin
  select f0.*, s.user_id as owner_id, s.status as session_status, s.expires_at
    into f from public.upload_session_files f0
    join public.upload_sessions s on s.id = f0.session_id
   where f0.id = p_file_id and f0.session_id = p_session_id
   for update of f0, s;
  if not found or f.owner_id <> p_user_id or f.session_status not in ('pending_upload','verifying','uploaded','processing')
     or f.expires_at <= now() then return null; end if;
  if f.status <> 'pending_upload' and
    not (f.status = 'verifying' and f.verification_lease_until <= now()) then
    return null;
  end if;
  if f.upload_transport = 'authenticated_parts' then
    expected_parts := ceil(f.expected_size_bytes::numeric / 8388608)::integer;
    select count(*) into completed_parts from public.upload_session_parts
     where file_id = p_file_id and generation = f.upload_generation and status = 'completed';
    if completed_parts <> expected_parts then return null; end if;
  end if;
  update public.upload_session_files
     set status = 'verifying', verification_token = token,
         verification_lease_until = now() + interval '5 minutes', updated_at = now()
   where id = p_file_id;
  return token;
end;
$$;

create or replace function public.finish_upload_verification(
  p_session_id uuid, p_file_id uuid, p_user_id text, p_claim_token uuid,
  p_status text, p_observed_size bigint default null, p_etag text default null,
  p_sealed_path text default null, p_error_code text default null
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare f record;
begin
  select f0.id, f0.verification_token, f0.verification_lease_until,
         f0.status, s.user_id, s.status as session_status
    into f from public.upload_session_files f0
    join public.upload_sessions s on s.id = f0.session_id
   where f0.id = p_file_id and f0.session_id = p_session_id
   for update of f0, s;
  if not found or f.user_id <> p_user_id or f.status <> 'verifying'
     or f.verification_token <> p_claim_token or f.verification_lease_until <= now()
     or f.session_status in ('cancelled', 'expired', 'completed', 'error') then return false; end if;
  if p_status not in ('pending_upload', 'uploaded', 'error') then
    raise exception using errcode = '22023', message = 'invalid_verification_status';
  end if;
  update public.upload_session_files
     set status = p_status, observed_size_bytes = p_observed_size,
         etag = p_etag,
         sealed_storage_path = coalesce(p_sealed_path, sealed_storage_path),
         error_code = p_error_code, verification_token = null,
         verification_lease_until = null, updated_at = now()
   where id = p_file_id;
  return true;
end;
$$;

create or replace function public.reclaim_expired_upload_verifications(
  p_session_id uuid, p_user_id text
) returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare reclaimed integer;
begin
  if not exists(select 1 from public.upload_sessions where id=p_session_id and user_id=p_user_id
    and status in ('pending_upload','verifying','uploaded','processing') and expires_at>now()) then
    return 0;
  end if;
  update public.upload_session_files set status='pending_upload',verification_token=null,
    verification_lease_until=null,error_code=null,updated_at=now()
    where session_id=p_session_id and status='verifying' and verification_lease_until<=now();
  get diagnostics reclaimed = row_count;
  return reclaimed;
end;
$$;

create or replace function public.queue_upload_session_cleanup(p_session_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare s record; paths text[];
begin
  select * into s from public.upload_sessions where id=p_session_id for update;
  if not found or s.status not in ('cancelled','expired','error') or s.cleaned_at is not null then return false; end if;
  select array_agg(distinct regexp_replace(staging_storage_path,'/staging$','/')) into paths
    from public.upload_session_files where session_id=p_session_id
      and status not in ('uploaded','processing','completed');
  if coalesce(array_length(paths,1),0)>0 then
    insert into public.db_jobs(kind,payload,max_attempts)
      values('storage.cleanup',jsonb_build_object('keys','[]'::jsonb,'prefixes',to_jsonb(paths)),8);
    -- A signed direct R2 PUT may still be in flight after cancellation. Sweep
    -- again once its maximum URL lifetime has elapsed.
    insert into public.db_jobs(kind,payload,max_attempts,run_at)
      values('storage.cleanup',jsonb_build_object('keys','[]'::jsonb,'prefixes',to_jsonb(paths)),8,
        now()+interval '16 minutes');
  end if;
  update public.upload_sessions set cleaned_at=now(),updated_at=now() where id=p_session_id;
  return true;
end;
$$;

create or replace function public.cancel_upload_session(p_session_id uuid,p_user_id text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare s record;
begin
  select * into s from public.upload_sessions where id=p_session_id and user_id=p_user_id for update;
  if not found or not (s.status='pending_upload' or
    (s.status='verifying' and s.updated_at <= now()-interval '5 minutes')) then return false; end if;
  if exists (select 1 from public.upload_session_files where session_id=p_session_id
     and status in ('uploaded','processing','completed')) then return false; end if;
  if exists (select 1 from public.upload_session_parts p
     join public.upload_session_files f on f.id=p.file_id
     where f.session_id=p_session_id and p.status='processing'
       and p.claimed_at > now()-interval '5 minutes') then return false; end if;
  update public.upload_sessions set status='cancelled',cancelled_at=now(),updated_at=now() where id=p_session_id;
  perform public.queue_upload_session_cleanup(p_session_id);
  return true;
end;
$$;

revoke all on public.upload_session_parts from public, web_anon, authenticated;
grant select, insert, update, delete on public.upload_session_parts to service_role;
revoke all on function public.claim_upload_part(uuid,uuid,text,uuid,integer,integer) from public,web_anon,authenticated;
revoke all on function public.complete_upload_part(uuid,uuid,text,uuid,integer,uuid) from public,web_anon,authenticated;
revoke all on function public.claim_upload_verification(uuid,uuid,text) from public,web_anon,authenticated;
revoke all on function public.finish_upload_verification(uuid,uuid,text,uuid,text,bigint,text,text,text) from public,web_anon,authenticated;
revoke all on function public.reclaim_expired_upload_verifications(uuid,text) from public,web_anon,authenticated;
revoke all on function public.queue_upload_session_cleanup(uuid) from public,web_anon,authenticated;
revoke all on function public.cancel_upload_session(uuid,text) from public,web_anon,authenticated;
grant execute on function public.claim_upload_part(uuid,uuid,text,uuid,integer,integer) to service_role;
grant execute on function public.complete_upload_part(uuid,uuid,text,uuid,integer,uuid) to service_role;
grant execute on function public.claim_upload_verification(uuid,uuid,text) to service_role;
grant execute on function public.finish_upload_verification(uuid,uuid,text,uuid,text,bigint,text,text,text) to service_role;
grant execute on function public.reclaim_expired_upload_verifications(uuid,text) to service_role;
grant execute on function public.queue_upload_session_cleanup(uuid) to service_role;
grant execute on function public.cancel_upload_session(uuid,text) to service_role;

commit;
notify pgrst, 'reload schema';
