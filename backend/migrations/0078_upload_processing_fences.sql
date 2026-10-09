-- Publish a prepared upload and its job result in one transaction. External
-- storage copies use claim-specific keys; a worker whose lease was stolen may
-- finish copying but cannot change any visible document/reference row.
begin;
alter table public.upload_processing_jobs add column if not exists claim_token uuid;

create or replace function public.renew_upload_processing_job(
  p_job_id uuid, p_worker_id text, p_attempt integer, p_token uuid,
  p_lease_seconds integer default 1800
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_lease_seconds not between 60 and 3600 then return false; end if;
  update public.upload_processing_jobs set locked_at=now(), updated_at=now()
   where id=p_job_id and status='running' and locked_by=p_worker_id
     and attempts=p_attempt and claim_token=p_token
     and locked_at > now()-make_interval(secs=>p_lease_seconds);
  return found;
end; $$;

create or replace function public.expire_exhausted_upload_jobs(
  p_lease_seconds integer default 1800, p_limit integer default 20
) returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare j record; expired_count integer := 0;
begin
  if p_lease_seconds not between 60 and 3600 or p_limit not between 1 and 100 then
    raise exception 'invalid_upload_expiry_limit';
  end if;
  for j in select id,session_id,file_id from public.upload_processing_jobs
    where status='running' and attempts>=3
      and locked_at <= now()-make_interval(secs=>p_lease_seconds)
    order by locked_at for update skip locked limit p_limit
  loop
    update public.upload_processing_jobs set status='error',locked_at=null,locked_by=null,
      claim_token=null,error_code='retry_limit_exceeded',updated_at=now() where id=j.id;
    update public.upload_session_files set status='error',error_code='processing_failed',updated_at=now()
      where id=j.file_id and session_id=j.session_id and status='processing';
    perform public.refresh_upload_session_status(j.session_id);
    expired_count := expired_count+1;
  end loop;
  return expired_count;
end; $$;

create or replace function public.finish_upload_processing_job(
  p_job_id uuid, p_worker_id text, p_attempt integer, p_token uuid,
  p_payload jsonb, p_failure text default null,
  p_lease_seconds integer default 1800
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  j public.upload_processing_jobs%rowtype;
  f public.upload_session_files%rowtype;
  s public.upload_sessions%rowtype;
  d public.documents%rowtype;
  v public.document_versions%rowtype;
  r public.workflow_reference_documents%rowtype;
  published_result jsonb;
  next_version integer;
  reference_id uuid;
  owner_id text;
  cleanup_paths text[];
begin
  select * into j from public.upload_processing_jobs where id=p_job_id for update;
  if not found or j.status <> 'running' or j.locked_by <> p_worker_id
    or j.attempts <> p_attempt or j.claim_token <> p_token
    or j.locked_at <= now()-make_interval(secs=>p_lease_seconds) then return null; end if;
  select * into f from public.upload_session_files where id=j.file_id and session_id=j.session_id for update;
  select * into s from public.upload_sessions where id=j.session_id for update;
  if f.id is null or s.id is null or s.user_id <> j.user_id or f.status <> 'processing'
     or s.status in ('cancelled','expired','error','completed') then return null; end if;
  if p_failure is not null then
    if p_failure <> 'processing_failed' then raise exception 'invalid_upload_failure'; end if;
    if j.attempts < 3 then
      update public.upload_processing_jobs set status='queued', available_at=now()+make_interval(secs=>j.attempts*5),
        locked_at=null, locked_by=null, claim_token=null, error_code=p_failure, updated_at=now() where id=j.id;
      update public.upload_session_files set status='uploaded', error_code=null, updated_at=now() where id=f.id;
    else
      update public.upload_processing_jobs set status='completed', locked_at=null, locked_by=null,
        claim_token=null, error_code='partial_failure', updated_at=now() where id=j.id;
      update public.upload_session_files set status='error', error_code=p_failure, updated_at=now() where id=f.id;
    end if;
    perform public.refresh_upload_session_status(s.id);
    return jsonb_build_object('status',case when j.attempts<3 then 'retry' else 'error' end);
  end if;
  if p_payload is null or p_payload->>'kind' <> s.purpose
    or length(coalesce(p_payload->>'source_path','')) < 1
    or (p_payload->>'size_bytes')::bigint <> f.expected_size_bytes then
    raise exception 'invalid_upload_result';
  end if;
  cleanup_paths := array[f.staging_storage_path,f.sealed_storage_path];

  if s.purpose = 'document_create' then
    insert into public.documents(id,project_id,user_id,status,folder_id,library_kind,library_folder_id)
    values(f.resource_id,(p_payload->>'project_id')::uuid,s.user_id,'processing',
      (p_payload->>'folder_id')::uuid,coalesce(p_payload->>'library_kind','file'),
      (p_payload->>'library_folder_id')::uuid);
    insert into public.document_versions(id,document_id,storage_path,pdf_storage_path,source,
      version_number,filename,file_type,size_bytes,page_count,content_sha256)
    values(f.id,f.resource_id,p_payload->>'source_path',p_payload->>'pdf_path','upload',
      1,f.filename,f.file_type,f.expected_size_bytes,(p_payload->>'page_count')::integer,p_payload->>'sha256');
    update public.documents set current_version_id=f.id,status='ready',updated_at=now() where id=f.resource_id returning * into d;
    published_result := to_jsonb(d) || jsonb_build_object('filename',f.filename,'storage_path',p_payload->>'source_path',
      'pdf_storage_path',p_payload->>'pdf_path','folder_id',coalesce(d.library_folder_id,d.folder_id),
      'file_type',f.file_type,'size_bytes',f.expected_size_bytes,
      'page_count',(p_payload->>'page_count')::integer,'active_version_number',1);
  elsif s.purpose = 'document_version_create' then
    select * into d from public.documents where id=(s.destination->>'document_id')::uuid and user_id=s.user_id for update;
    if not found then raise exception 'document_not_found'; end if;
    select coalesce(max(version_number),1)+1 into next_version from public.document_versions
      where document_id=d.id and source in ('upload','user_upload','assistant_edit');
    insert into public.document_versions(id,document_id,storage_path,pdf_storage_path,source,
      version_number,filename,file_type,size_bytes,page_count,content_sha256)
    values(f.resource_id,d.id,p_payload->>'source_path',p_payload->>'pdf_path','user_upload',
      next_version,p_payload->>'filename',f.file_type,f.expected_size_bytes,
      (p_payload->>'page_count')::integer,p_payload->>'sha256') returning * into v;
    update public.documents set current_version_id=v.id,updated_at=now() where id=d.id;
    published_result := to_jsonb(v);
  elsif s.purpose = 'document_version_replace' then
    select * into d from public.documents where id=(s.destination->>'document_id')::uuid and user_id=s.user_id for update;
    if not found then raise exception 'document_not_found'; end if;
    select * into v from public.document_versions
      where id=(s.destination->>'version_id')::uuid and document_id=d.id and deleted_at is null for update;
    if not found then raise exception 'version_not_found'; end if;
    cleanup_paths := cleanup_paths || array[v.storage_path,v.pdf_storage_path];
    update public.document_versions set storage_path=p_payload->>'source_path',pdf_storage_path=p_payload->>'pdf_path',
      filename=f.filename,file_type=f.file_type,size_bytes=f.expected_size_bytes,
      page_count=(p_payload->>'page_count')::integer,content_sha256=p_payload->>'sha256',created_at=now()
      where id=(s.destination->>'version_id')::uuid and document_id=d.id and deleted_at is null returning * into v;
    if not found then raise exception 'version_not_found'; end if;
    update public.documents set current_version_id=v.id,updated_at=now() where id=d.id;
    published_result := to_jsonb(v);
  elsif s.purpose in ('workflow_reference_create','workflow_reference_replace') then
    select coalesce(user_id,s.user_id) into owner_id from public.workflows
      where id=(s.destination->>'workflow_id')::uuid;
    if not found or owner_id <> p_payload->>'owner_id' then raise exception 'workflow_owner_changed'; end if;
    reference_id := case when s.purpose='workflow_reference_replace'
      then (s.destination->>'reference_id')::uuid else f.resource_id end;
    if s.purpose='workflow_reference_create' then
      insert into public.workflow_reference_documents(id,workflow_id,user_id,filename,file_type,
        storage_path,size_bytes,content_hash,updated_at)
      values(reference_id,(s.destination->>'workflow_id')::uuid,owner_id,f.filename,f.file_type,
        p_payload->>'source_path',f.expected_size_bytes,p_payload->>'sha256',now()) returning * into r;
    else
      select * into r from public.workflow_reference_documents
       where id=reference_id and workflow_id=(s.destination->>'workflow_id')::uuid for update;
      if not found then raise exception 'reference_not_found'; end if;
      cleanup_paths := cleanup_paths || array[r.storage_path];
      update public.workflow_reference_documents set filename=f.filename,file_type=f.file_type,
        storage_path=p_payload->>'source_path',size_bytes=f.expected_size_bytes,
        content_hash=p_payload->>'sha256',updated_at=now()
       where id=reference_id and workflow_id=(s.destination->>'workflow_id')::uuid returning * into r;
      if not found then raise exception 'reference_not_found'; end if;
    end if;
    published_result := to_jsonb(r);
  else raise exception 'invalid_upload_purpose'; end if;

  update public.upload_session_files set status='completed',result=published_result,error_code=null,updated_at=now() where id=f.id;
  update public.upload_processing_jobs set status='completed',locked_at=null,locked_by=null,
    claim_token=null,error_code=null,updated_at=now() where id=j.id;
  insert into public.db_jobs(kind,payload,max_attempts)
    values('storage.cleanup',jsonb_build_object('keys',
      to_jsonb(array_remove(cleanup_paths,null)),'prefixes','[]'::jsonb),8);
  insert into public.db_jobs(kind,payload,max_attempts,run_at)
    values('storage.cleanup',jsonb_build_object('keys',
      to_jsonb(array_remove(cleanup_paths,null)),'prefixes','[]'::jsonb),8,
      now()+interval '16 minutes');
  perform public.refresh_upload_session_status(s.id);
  return jsonb_build_object('status','completed','result',published_result);
end; $$;

revoke all on function public.renew_upload_processing_job(uuid,text,integer,uuid,integer)
  from public,web_anon,authenticated;
revoke all on function public.finish_upload_processing_job(uuid,text,integer,uuid,jsonb,text,integer)
  from public,web_anon,authenticated;
revoke all on function public.expire_exhausted_upload_jobs(integer,integer)
  from public,web_anon,authenticated;
grant execute on function public.renew_upload_processing_job(uuid,text,integer,uuid,integer) to service_role;
grant execute on function public.finish_upload_processing_job(uuid,text,integer,uuid,jsonb,text,integer) to service_role;
grant execute on function public.expire_exhausted_upload_jobs(integer,integer) to service_role;
commit;
notify pgrst, 'reload schema';
