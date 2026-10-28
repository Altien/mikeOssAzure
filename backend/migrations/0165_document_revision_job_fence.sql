-- Source180: extend the existing revision publication seam; old callers retain defaults.
drop function if exists public.create_document_version(uuid,jsonb,boolean);
create or replace function public.create_document_version(
  p_document_id uuid, p_version jsonb, p_activate boolean default true,
  p_job_identity jsonb default null,p_expected_version jsonb default null,p_edits jsonb default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid := coalesce((p_version->>'id')::uuid, gen_random_uuid());
  v_row public.document_versions%rowtype;
  v_number integer;
  v_job public.db_jobs; v_guard jsonb; v_edits jsonb;
begin
  if p_job_identity is not null then
    select * into v_job from public.db_jobs where id=(p_job_identity->>'id')::uuid for update;
    if not found or v_job.kind<>'playbook.review' or v_job.attempts is distinct from (p_job_identity->>'attempt')::integer
      or v_job.claim_token is distinct from (p_job_identity->>'token')::uuid or v_job.status<>'running'
      or v_job.lease_expires_at is null or v_job.lease_expires_at<=clock_timestamp()
      then raise exception 'playbook_claim_lost' using errcode='40001'; end if;
    v_guard:=public.mutate_playbook_job(v_job.id,v_job.attempts,v_job.claim_token,'document_check',(v_job.payload->>'runId')::uuid);
    if v_guard->>'result'<>'current' then raise exception 'playbook_document_scope_changed' using errcode='40001'; end if;
    if not exists(select 1 from public.playbook_runs r where r.id=(v_job.payload->>'runId')::uuid
      and r.document_id=p_document_id and r.user_id=v_job.payload->>'userId' and r.status='running')
      then raise exception 'playbook_document_scope_changed' using errcode='40001'; end if;
    if p_expected_version is distinct from v_job.payload->'expectedVersion'
      or p_edits is null or jsonb_typeof(p_edits)<>'array' or jsonb_array_length(p_edits)>1000
      then raise exception 'playbook_document_input_changed' using errcode='40001'; end if;
  end if;
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
  if p_job_identity is not null then
    insert into public.document_edits(document_id,version_id,change_id,del_w_id,ins_w_id,deleted_text,inserted_text,context_before,context_after,status)
      select p_document_id,v_id,item->>'change_id',item->>'del_w_id',item->>'ins_w_id',item->>'deleted_text',item->>'inserted_text',
        coalesce(item->>'context_before',''),coalesce(item->>'context_after',''),'pending'
      from jsonb_array_elements(p_edits) item;
    select coalesce(jsonb_agg(to_jsonb(e)),'[]'::jsonb) into v_edits from public.document_edits e where e.version_id=v_id;
  end if;
  if p_job_identity is not null then
    if v_job.lease_expires_at<=clock_timestamp() then raise exception 'playbook_claim_lost' using errcode='40001'; end if;
    -- A retry can observe the revision already applied by this domain run,
    -- without applying it twice after an ambiguous transport/crash.
    update public.playbook_runs set edited_version_id=v_id,updated_at=clock_timestamp()
      where id=(v_job.payload->>'runId')::uuid and status='running';
  end if;
  if p_activate then
    update public.documents set current_version_id = v_id, updated_at = now()
      where id = p_document_id;
  end if;
  return to_jsonb(v_row) || case when p_job_identity is not null then jsonb_build_object('edit_rows',v_edits) else '{}'::jsonb end;
end;
$$;
revoke all on function public.create_document_version(uuid,jsonb,boolean,jsonb,jsonb,jsonb) from public,web_anon,authenticated;
grant execute on function public.create_document_version(uuid,jsonb,boolean,jsonb,jsonb,jsonb) to service_role;
notify pgrst,'reload schema';
