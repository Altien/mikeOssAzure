-- Dev compatibility seam for source199–202. Allocate provisional numbering at actual pick.
-- Existing queue/read RPCs gain defaulted trailing args; remove old signatures to avoid PostgREST ambiguity.
drop function if exists public.queue_document_text(uuid,boolean);
create or replace function public.queue_document_text(p_version_id uuid, p_retry_failed boolean default false, p_precompute_job jsonb default null)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare v public.document_versions%rowtype; t public.document_version_texts%rowtype; j public.db_jobs%rowtype;
begin
  if p_precompute_job is not null then
    select * into j from public.db_jobs where id=(p_precompute_job->>'id')::uuid for update;
    if not found or j.kind<>'document.precompute_text' or j.status<>'running'
      or j.attempts is distinct from (p_precompute_job->>'attempt')::integer
      or j.claim_token is null or j.claim_token is distinct from (p_precompute_job->>'token')::uuid
      or j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp()
      or j.payload->>'versionId' is distinct from p_version_id::text then return false; end if;
  end if;
  select * into v from public.document_versions where id=p_version_id and deleted_at is null and storage_path is not null for update;
  if not found then return false; end if;
  if p_precompute_job is not null and (v.storage_path is distinct from j.payload->>'storagePath'
    or j.lease_expires_at<=clock_timestamp()) then return false; end if;
  select * into t from public.document_version_texts where version_id=v.id;
  if t.source_revision=v.text_revision and t.extractor_version=1 and
    (t.status='ready' or (t.status='failed' and not p_retry_failed)) then return false; end if;
  if exists(select 1 from public.db_jobs where dedupe_key='document.text:'||v.id||':'||v.text_revision
    and status in ('pending','running')) then return false; end if;
  insert into public.document_version_texts(version_id,source_revision)
    values(v.id,v.text_revision)
    on conflict(version_id) do update set source_revision=excluded.source_revision,
      extractor_version=1,status='pending',text_content=null,source_sha256=null,
      textless_page_count=null,error_code=null,updated_at=now();
  insert into public.db_jobs(kind,payload,dedupe_key,max_attempts,run_at)
    values('document.extract_text',jsonb_build_object('versionId',v.id,'revision',v.text_revision),
      'document.text:'||v.id||':'||v.text_revision,3,now()+interval '2 seconds')
    on conflict do nothing;
  if p_precompute_job is not null and j.lease_expires_at<=clock_timestamp() then
    raise exception 'document_precompute_claim_lost' using errcode='40001';
  end if;
  return true;
end;
$$;
drop function if exists public.read_document_text(text,text,uuid,uuid);
create or replace function public.read_document_text(p_user_id text,p_user_email text,p_document_id uuid,p_version_id uuid,p_expected_storage_path text default null)
returns jsonb language sql stable security invoker set search_path=public,pg_temp as $$
  select jsonb_build_object('revision',v.text_revision,'status',coalesce(t.status,'pending'),
    'text',t.text_content,'textless_page_count',t.textless_page_count)
  from public.document_versions v left join public.document_version_texts t
    on t.version_id=v.id and t.source_revision=v.text_revision and t.extractor_version=1
  where v.id=p_version_id and v.document_id=p_document_id and v.deleted_at is null
    and (p_expected_storage_path is null or v.storage_path=p_expected_storage_path)
    and public.document_text_access(p_document_id,p_user_id,p_user_email);
$$;
revoke all on function public.queue_document_text(uuid,boolean,jsonb),public.read_document_text(text,text,uuid,uuid,text) from public,web_anon,authenticated;
grant execute on function public.queue_document_text(uuid,boolean,jsonb),public.read_document_text(text,text,uuid,uuid,text) to service_role;
notify pgrst,'reload schema';
