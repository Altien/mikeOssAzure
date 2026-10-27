-- Source198 candidate. Provisional numbering; reconcile the actual197/198 contract.
-- Extend canonical failure entrypoint: running resource refusal and retained-token terminal hook.
drop function if exists public.fail_document_text_job(uuid,integer,uuid,uuid,uuid);
create or replace function public.fail_document_text_job(
  p_job_id uuid,p_attempt integer,p_token uuid,p_version_id uuid,p_revision uuid,
  p_error_code text default 'extraction_failed',p_running boolean default false
) returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare j public.db_jobs%rowtype;
begin
  select * into j from public.db_jobs where id=p_job_id for update;
  if not found or j.kind <> 'document.extract_text' 
    or j.attempts is distinct from p_attempt or j.claim_token is distinct from p_token
    or (p_running and (j.status<>'running' or j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp()))
    or (not p_running and (j.status<>'failed' or j.finished_at is null or j.lease_expires_at is not null))
    or j.payload->>'versionId' is distinct from p_version_id::text
    or j.payload->>'revision' is distinct from p_revision::text then return false; end if;
  perform 1 from public.document_versions
    where id=p_version_id and text_revision=p_revision and deleted_at is null for update;
  if not found then return false; end if;
  if exists(select 1 from public.db_jobs retry where retry.id<>j.id
    and retry.dedupe_key='document.text:'||p_version_id||':'||p_revision
    and retry.status in ('pending','running')) then return false; end if;
  if p_running and j.lease_expires_at<=clock_timestamp() then return false; end if;
  update public.document_version_texts set status='failed',text_content=null,
    error_code=case when p_error_code='too_large' then 'too_large' else 'extraction_failed' end,updated_at=now()
    where version_id=p_version_id and source_revision=p_revision and extractor_version=1
      and status in ('pending','processing','failed');
  if p_running and j.lease_expires_at<=clock_timestamp() then raise exception 'document_text_claim_lost' using errcode='40001'; end if;
  return found;
end;
$;
create or replace function public.document_text_job_failed()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare version_id uuid; revision uuid;
begin
  begin
    version_id:=(new.payload->>'versionId')::uuid;
    revision:=(new.payload->>'revision')::uuid;
  exception when invalid_text_representation then return null;
  end;
  -- This trigger owns the actual failed-job transition, including the stale
  -- sweep that clears its token. Canonical RPC checks current failed row,
  -- attempt/token, revision and absence of a pending/running successor.
  perform public.fail_document_text_job(new.id,new.attempts,new.claim_token,version_id,revision);
  return null;
end;
$$;
drop trigger if exists document_text_job_failed on public.db_jobs;
create trigger document_text_job_failed after update of status on public.db_jobs
  for each row when(new.kind='document.extract_text' and new.status='failed' and old.status is distinct from 'failed')
  execute function public.document_text_job_failed();
do $$
declare failed public.db_jobs;
begin
  -- Migration repair uses the same job → version → text lock order and current
  -- successor guard. Never revive/overwrite a newer retry or ready revision.
  for failed in select * from public.db_jobs where kind='document.extract_text' and status='failed'
    order by id for update skip locked loop
    begin
      perform public.fail_document_text_job(failed.id,failed.attempts,failed.claim_token,
        (failed.payload->>'versionId')::uuid,(failed.payload->>'revision')::uuid);
    exception when invalid_text_representation then null;
    end;
  end loop;
end;
$$;
revoke all on function public.fail_document_text_job(uuid,integer,uuid,uuid,uuid,text,boolean),public.document_text_job_failed()
  from public,web_anon,authenticated;
grant execute on function public.fail_document_text_job(uuid,integer,uuid,uuid,uuid,text,boolean),public.document_text_job_failed() to service_role;
notify pgrst,'reload schema';
