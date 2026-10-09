-- Dev numbered adaptation of upstream cf5fa985/f3fa62e6 (#537, PDF text-layer
-- detection; upstream file 20261008_02_document_version_textless_pages.sql).
--
-- Record how many pages of an uploaded PDF have no text layer, so scanned PDFs
-- without OCR can be flagged in the document list. Null means not measured:
-- non-PDF files and versions created before this migration.
--
-- Dev divergences (see UPSTREAM_SYNC_LOG.md, cf5fa985):
-- - Upstream writes the count from uploads.processing.ts through
--   create_document_version/updateDocumentVersion. Dev's upload worker only
--   prepares claim-specific objects; finish_upload_processing_job publishes
--   them in one claim-fenced transaction. That RPC therefore stores
--   textless_page_count from the worker payload too. Everything else in it is
--   unchanged from 0098.
-- - create_document_version keeps 0089's body with the column added (copies
--   of a version carry the value over).
-- - search_library_documents keeps 0046's Dev body (text user_id) and gains
--   the output column. The return type changes, so it is dropped first.
-- - Exact grants: all three functions are service_role only (revoked from
--   public, web_anon, authenticated). No RLS, no auth schema.
-- Idempotent: add column if not exists, create or replace, drop-if-exists.
begin;

alter table public.document_versions
  add column if not exists textless_page_count integer;

create or replace function public.create_document_version(
  p_document_id uuid, p_version jsonb, p_activate boolean default true
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid := coalesce((p_version->>'id')::uuid, gen_random_uuid());
  v_row public.document_versions%rowtype;
  v_number integer;
begin
  perform 1 from public.documents where id = p_document_id for update;
  if not found then raise exception 'document_not_found' using errcode = 'P0002'; end if;
  select * into v_row from public.document_versions where id = v_id;
  if found then
    if v_row.document_id <> p_document_id or v_row.deleted_at is not null then
      raise exception 'version_identity_conflict' using errcode = '23505';
    end if;
    -- An upload retry must not overwrite metadata or reactivate an older
    -- version after somebody has already created a newer one.
    return to_jsonb(v_row);
  end if;
  v_number := (p_version->>'version_number')::integer;
  if v_number is null then
    select coalesce(max(version_number), 1) + 1 into v_number
    from public.document_versions
    where document_id = p_document_id
      and source in ('upload', 'user_upload', 'assistant_edit');
  end if;
  insert into public.document_versions(
    id, document_id, storage_path, pdf_storage_path, source, version_number,
    filename, file_type, size_bytes, page_count, textless_page_count,
    content_sha256
  ) values (
    v_id, p_document_id, p_version->>'storage_path', p_version->>'pdf_storage_path',
    coalesce(p_version->>'source', 'upload'), v_number,
    p_version->>'filename', p_version->>'file_type',
    (p_version->>'size_bytes')::integer, (p_version->>'page_count')::integer,
    (p_version->>'textless_page_count')::integer,
    p_version->>'content_sha256'
  ) returning * into v_row;
  if p_activate then
    update public.documents set current_version_id = v_id, updated_at = now()
      where id = p_document_id;
  end if;
  return to_jsonb(v_row);
end;
$$;
revoke all on function public.create_document_version(uuid, jsonb, boolean) from public, web_anon, authenticated;
grant execute on function public.create_document_version(uuid, jsonb, boolean) to service_role;

-- Library search returns the active version's metadata row by row, so it gains
-- the column too. Adding an output column changes the return type, which
-- `create or replace` cannot do.
drop function if exists public.search_library_documents(
  text, text, integer, integer, text, text, text, text
);

create or replace function public.search_library_documents(
  p_user_id text,
  p_library_kind text,
  p_limit integer,
  p_offset integer,
  p_search_term text default null,
  p_file_type text default null,
  p_sort_key text default 'updated',
  p_sort_direction text default 'desc'
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  status text,
  folder_id uuid,
  library_kind text,
  library_folder_id uuid,
  current_version_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  filename text,
  file_type text,
  storage_path text,
  pdf_storage_path text,
  size_bytes integer,
  page_count integer,
  textless_page_count integer,
  active_version_number integer
)
language sql
stable
as $$
  select
    d.id,
    d.project_id,
    d.user_id,
    d.status,
    d.folder_id,
    d.library_kind,
    d.library_folder_id,
    d.current_version_id,
    d.created_at,
    d.updated_at,
    coalesce(nullif(trim(v.filename), ''), 'Untitled document') as filename,
    v.file_type,
    v.storage_path,
    v.pdf_storage_path,
    v.size_bytes,
    v.page_count,
    v.textless_page_count,
    v.version_number as active_version_number
  from public.documents d
  left join public.document_versions v
    on v.id = d.current_version_id
   and v.deleted_at is null
  where d.user_id = p_user_id
    and d.project_id is null
    and (
      (p_library_kind = 'file' and coalesce(d.library_kind, 'file') = 'file')
      or d.library_kind = p_library_kind
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(coalesce(v.filename, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (
      p_file_type is null
      or lower(coalesce(v.file_type, '')) = lower(p_file_type)
    )
  order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(v.filename, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(v.filename, '')) else null end desc,
    case when p_sort_key = 'type' and p_sort_direction = 'asc' then lower(coalesce(v.file_type, '')) else null end asc,
    case when p_sort_key = 'type' and p_sort_direction = 'desc' then lower(coalesce(v.file_type, '')) else null end desc,
    case when p_sort_key = 'size' and p_sort_direction = 'asc' then coalesce(v.size_bytes, 0) else null end asc,
    case when p_sort_key = 'size' and p_sort_direction = 'desc' then coalesce(v.size_bytes, 0) else null end desc,
    case when p_sort_key = 'version' and p_sort_direction = 'asc' then coalesce(v.version_number, 0) else null end asc,
    case when p_sort_key = 'version' and p_sort_direction = 'desc' then coalesce(v.version_number, 0) else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then d.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then d.created_at else null end desc,
    case when p_sort_key = 'updated' and p_sort_direction = 'asc' then d.updated_at else null end asc,
    case when p_sort_key = 'updated' and p_sort_direction = 'desc' then d.updated_at else null end desc,
    d.updated_at desc,
    d.id asc
  limit greatest(coalesce(p_limit, 50), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;
revoke all on function public.search_library_documents(text, text, integer, integer, text, text, text, text)
  from public, web_anon, authenticated;
grant execute on function public.search_library_documents(text, text, integer, integer, text, text, text, text)
  to service_role;

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
      version_number,filename,file_type,size_bytes,page_count,textless_page_count,content_sha256)
    values(f.id,f.resource_id,p_payload->>'source_path',p_payload->>'pdf_path','upload',
      1,f.filename,f.file_type,f.expected_size_bytes,(p_payload->>'page_count')::integer,
      (p_payload->>'textless_page_count')::integer,p_payload->>'sha256');
    update public.documents set current_version_id=f.id,status='ready',updated_at=now() where id=f.resource_id returning * into d;
    published_result := to_jsonb(d) || jsonb_build_object('filename',f.filename,'storage_path',p_payload->>'source_path',
      'pdf_storage_path',p_payload->>'pdf_path','folder_id',coalesce(d.library_folder_id,d.folder_id),
      'file_type',f.file_type,'size_bytes',f.expected_size_bytes,
      'page_count',(p_payload->>'page_count')::integer,
      'textless_page_count',(p_payload->>'textless_page_count')::integer,'active_version_number',1);
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
      version_number,filename,file_type,size_bytes,page_count,textless_page_count,content_sha256)
    values(f.resource_id,d.id,p_payload->>'source_path',p_payload->>'pdf_path','user_upload',
      next_version,p_payload->>'filename',f.file_type,f.expected_size_bytes,
      (p_payload->>'page_count')::integer,(p_payload->>'textless_page_count')::integer,
      p_payload->>'sha256') returning * into v;
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
      page_count=(p_payload->>'page_count')::integer,
      textless_page_count=(p_payload->>'textless_page_count')::integer,
      content_sha256=p_payload->>'sha256',created_at=now()
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
