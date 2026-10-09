-- Dev numbered adaptation of upstream d146998d / 4cc88fa3 (#603, access
-- hardening; upstream file 20261008_01_email_change_moves_grants.sql, first
-- dated 20261007_01).
--
-- Move email-keyed access grants with the account when its email changes.
-- project_access_grants, chat_access_grants, tabular_review_access_grants and
-- workflow_shares are keyed by normalized email. Left behind, a renamed
-- account silently loses its shares, and whoever later holds the old address
-- (a reassigned mailbox or UPN) inherits them, Owner grants included.
--
-- Dev divergences (see UPSTREAM_SYNC_LOG.md, d146998d):
-- - Upstream fires on auth.users (Supabase email change). Dev has no auth
--   schema; the IdP email (Entra preferred_username/email/upn, or Supabase)
--   reaches public.user_profiles on every authenticated request
--   (upsertUserProfile), so the trigger is on user_profiles.email and runs
--   when the IdP first reports the new address for the same user_id (oid).
-- - Because Dev observes the change lazily, another account may already have
--   signed in with the old address. When any OTHER profile currently holds
--   the old address, nothing moves: the grants stay with the address holder,
--   exactly as email-keyed matching treats them today, and the renamed
--   account is never handed grants made to someone else.
-- - An empty new address (a token without an email claim) moves and deletes
--   nothing; upstream deleted the old address's grants. A missing claim is
--   not proof the address was given up.
-- - A grant already held by the new address is kept at the stronger role.
-- - The move is atomic and never blocks sign-in: any error rolls back the
--   whole move (grants stay put) and raises a WARNING instead.
-- - Emails compare lower(btrim(...)); grant columns carry lowercase CHECKs.
-- - finish_upload_processing_job (0104 body) now authorizes workflow-share
--   editors by `role in ('owner','editor')`. Since 0083/0084 `role` is the
--   authoritative share tier and new shares leave the legacy `allow_edit`
--   column at its default false, so the publish-time recheck denied real
--   editors and could admit a legacy share downgraded to viewer.
-- - Exact grants: both functions revoked from public, web_anon,
--   authenticated; the publish RPC is EXECUTE for service_role only. No RLS,
--   no auth schema.
-- Idempotent: create or replace plus drop-before-create of the trigger.
begin;

create or replace function public.move_email_keyed_grants_on_profile_email_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  old_email text := lower(btrim(coalesce(old.email, '')));
  new_email text := lower(btrim(coalesce(new.email, '')));
begin
  if old_email = '' or new_email = '' or old_email = new_email then
    return new;
  end if;
  if exists (
    select 1 from public.user_profiles other
     where other.user_id <> new.user_id
       and lower(btrim(coalesce(other.email, ''))) = old_email
  ) then
    return new;
  end if;

  begin
    update public.project_access_grants as kept
       set role = moved.role, updated_at = now()
      from public.project_access_grants as moved
     where moved.email = old_email
       and kept.email = new_email
       and kept.project_id = moved.project_id
       and (case moved.role when 'owner' then 2 when 'editor' then 1 else 0 end)
         > (case kept.role when 'owner' then 2 when 'editor' then 1 else 0 end);
    delete from public.project_access_grants as moved
     where moved.email = old_email
       and exists (
         select 1 from public.project_access_grants as kept
          where kept.project_id = moved.project_id
            and kept.email = new_email
       );
    update public.project_access_grants
       set email = new_email, updated_at = now()
     where email = old_email;

    update public.chat_access_grants as kept
       set role = moved.role, updated_at = now()
      from public.chat_access_grants as moved
     where moved.email = old_email
       and kept.email = new_email
       and kept.chat_id = moved.chat_id
       and (case moved.role when 'owner' then 2 when 'editor' then 1 else 0 end)
         > (case kept.role when 'owner' then 2 when 'editor' then 1 else 0 end);
    delete from public.chat_access_grants as moved
     where moved.email = old_email
       and exists (
         select 1 from public.chat_access_grants as kept
          where kept.chat_id = moved.chat_id
            and kept.email = new_email
       );
    update public.chat_access_grants
       set email = new_email, updated_at = now()
     where email = old_email;

    update public.tabular_review_access_grants as kept
       set role = moved.role, updated_at = now()
      from public.tabular_review_access_grants as moved
     where moved.email = old_email
       and kept.email = new_email
       and kept.tabular_review_id = moved.tabular_review_id
       and (case moved.role when 'owner' then 2 when 'editor' then 1 else 0 end)
         > (case kept.role when 'owner' then 2 when 'editor' then 1 else 0 end);
    delete from public.tabular_review_access_grants as moved
     where moved.email = old_email
       and exists (
         select 1 from public.tabular_review_access_grants as kept
          where kept.tabular_review_id = moved.tabular_review_id
            and kept.email = new_email
       );
    update public.tabular_review_access_grants
       set email = new_email, updated_at = now()
     where email = old_email;

    update public.workflow_shares as kept
       set role = moved.role
      from public.workflow_shares as moved
     where moved.shared_with_email = old_email
       and kept.shared_with_email = new_email
       and kept.workflow_id = moved.workflow_id
       and (case moved.role when 'owner' then 2 when 'editor' then 1 else 0 end)
         > (case kept.role when 'owner' then 2 when 'editor' then 1 else 0 end);
    delete from public.workflow_shares as moved
     where moved.shared_with_email = old_email
       and exists (
         select 1 from public.workflow_shares as kept
          where kept.workflow_id = moved.workflow_id
            and kept.shared_with_email = new_email
       );
    update public.workflow_shares
       set shared_with_email = new_email
     where shared_with_email = old_email;
  exception when others then
    raise warning 'email-keyed grants were not moved for user %: % (%)',
      new.user_id, sqlerrm, sqlstate;
  end;

  return new;
end;
$$;
revoke all on function public.move_email_keyed_grants_on_profile_email_change()
  from public, web_anon, authenticated;

drop trigger if exists user_profiles_email_moves_grants on public.user_profiles;
create trigger user_profiles_email_moves_grants
  after update of email on public.user_profiles
  for each row
  when (old.email is distinct from new.email)
  execute function public.move_email_keyed_grants_on_profile_email_change();

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
            and share.role in ('owner','editor')
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
            and share.role in ('owner','editor')
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
            and share.role in ('owner','editor')
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
