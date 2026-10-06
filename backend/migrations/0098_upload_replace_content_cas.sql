-- Upstream sync 6e3ef6fa (#559, DOCX editor autosave): a document version
-- replacement may carry the content hash the editor started from. Compare
-- the version's storage path and hash in the same claim-fenced transaction
-- that publishes the replacement, and fail the upload terminally as
-- 'document_changed' when another save, edit resolution or upload won first.
-- The losing upload's staged objects are definite orphans and are queued for
-- cleanup in that transaction; the winning version is never touched. The
-- worker reports a pre-publish hash mismatch through the same terminal code.
-- Everything else is unchanged from 0082.
begin;
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
  workflow_owner text;
  workflow_type text;
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
    if p_failure not in ('processing_failed','document_changed') then raise exception 'invalid_upload_failure'; end if;
    if p_failure = 'document_changed' then
      -- Terminal: retrying a stale editor save cannot succeed.
      if s.purpose <> 'document_version_replace' then raise exception 'invalid_upload_failure'; end if;
      update public.upload_processing_jobs set status='completed', locked_at=null, locked_by=null,
        claim_token=null, error_code=p_failure, updated_at=now() where id=j.id;
      update public.upload_session_files set status='error', error_code=p_failure, updated_at=now() where id=f.id;
      insert into public.db_jobs(kind,payload,max_attempts)
        values('storage.cleanup',jsonb_build_object('keys',
          to_jsonb(array_remove(array[f.staging_storage_path,f.sealed_storage_path],null)),'prefixes','[]'::jsonb),8);
      perform public.refresh_upload_session_status(s.id);
      return jsonb_build_object('status','error','error_code',p_failure);
    end if;
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
    if s.destination->>'scope' = 'workflow' then
      select user_id,type into workflow_owner,workflow_type from public.workflows
        where id=(s.destination->>'workflow_id')::uuid;
      if not found or workflow_type <> 'assistant' or not (
        workflow_owner = s.user_id or exists (
          select 1 from public.workflow_shares share
          where share.workflow_id=(s.destination->>'workflow_id')::uuid
            and share.shared_with_email=lower(trim(s.user_email))
            and share.allow_edit = true
        )
      ) then raise exception 'workflow_asset_edit_denied'; end if;
    end if;
    insert into public.documents(id,project_id,user_id,status,folder_id,library_kind,library_folder_id,workflow_id)
    values(f.resource_id,(p_payload->>'project_id')::uuid,s.user_id,'processing',
      (p_payload->>'folder_id')::uuid,
      case when s.destination->>'scope'='workflow' then 'workflow_asset'
           else coalesce(p_payload->>'library_kind','file') end,
      (p_payload->>'library_folder_id')::uuid,
      case when s.destination->>'scope'='workflow' then (s.destination->>'workflow_id')::uuid else null end);
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
    select * into d from public.documents where id=(s.destination->>'document_id')::uuid for update;
    if not found then raise exception 'document_not_found'; end if;
    if d.workflow_id is null then
      if d.user_id <> s.user_id then raise exception 'document_edit_denied'; end if;
    else
      select user_id,type into workflow_owner,workflow_type from public.workflows where id=d.workflow_id;
      if not found or workflow_type <> 'assistant' or not (
        workflow_owner = s.user_id or exists (
          select 1 from public.workflow_shares share
          where share.workflow_id=d.workflow_id
            and share.shared_with_email=lower(trim(s.user_email))
            and share.allow_edit = true
        )
      ) then raise exception 'workflow_asset_edit_denied'; end if;
    end if;
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
    select * into d from public.documents where id=(s.destination->>'document_id')::uuid for update;
    if not found then raise exception 'document_not_found'; end if;
    if d.workflow_id is null then
      if d.user_id <> s.user_id then raise exception 'document_edit_denied'; end if;
    else
      select user_id,type into workflow_owner,workflow_type from public.workflows where id=d.workflow_id;
      if not found or workflow_type <> 'assistant' or not (
        workflow_owner = s.user_id or exists (
          select 1 from public.workflow_shares share
          where share.workflow_id=d.workflow_id
            and share.shared_with_email=lower(trim(s.user_email))
            and share.allow_edit = true
        )
      ) then raise exception 'workflow_asset_edit_denied'; end if;
    end if;
    select * into v from public.document_versions
      where id=(s.destination->>'version_id')::uuid and document_id=d.id and deleted_at is null for update;
    if not found then raise exception 'version_not_found'; end if;
    if s.destination ? 'expected_content_sha256' then
      if not (p_payload ? 'expected_storage_path') then raise exception 'invalid_upload_result'; end if;
      if v.storage_path is distinct from p_payload->>'expected_storage_path'
         or v.content_sha256 is distinct from p_payload->>'expected_content_sha256' then
        -- Lost the compare-and-swap: keep the winner, discard only this
        -- upload's own staged objects.
        update public.upload_processing_jobs set status='completed', locked_at=null, locked_by=null,
          claim_token=null, error_code='document_changed', updated_at=now() where id=j.id;
        update public.upload_session_files set status='error', error_code='document_changed', updated_at=now() where id=f.id;
        insert into public.db_jobs(kind,payload,max_attempts)
          values('storage.cleanup',jsonb_build_object('keys',
            to_jsonb(array_remove(cleanup_paths || array[p_payload->>'source_path',p_payload->>'pdf_path'],null)),
            'prefixes','[]'::jsonb),8);
        perform public.refresh_upload_session_status(s.id);
        return jsonb_build_object('status','error','error_code','document_changed');
      end if;
    end if;
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
revoke all on function public.finish_upload_processing_job(uuid,text,integer,uuid,jsonb,text,integer)
  from public,web_anon,authenticated;
grant execute on function public.finish_upload_processing_job(uuid,text,integer,uuid,jsonb,text,integer)
  to service_role;
commit;
notify pgrst, 'reload schema';
