-- Migration date: 2026-11-25
-- Upstream: none (sync-log: 5e986237, "fix(upload): wait for a busy parser
-- instead of spending a DOCX upload's retry").
-- Upstream's worker requeues an upload job whose DOCX validation found the
-- parser still busy after its wait: the job goes back to queued 30 s later
-- with the attempt the claim charged given back, the file returns to
-- uploaded, and nothing is reported. Upstream does this with direct
-- job/file/session updates.
-- Dev divergence: dev records worker outcomes only through claim-token
-- fenced RPCs. This adds defer_upload_processing_job with the same fence as
-- finish_upload_processing_job (worker, attempt, token, live lease; file still
-- processing; session still open). It returns false when the claim is lost.
create or replace function public.defer_upload_processing_job(
  p_job_id uuid, p_worker_id text, p_attempt integer, p_token uuid,
  p_delay_seconds integer, p_error_code text,
  p_lease_seconds integer default 1800
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  j public.upload_processing_jobs%rowtype;
  f public.upload_session_files%rowtype;
  s public.upload_sessions%rowtype;
begin
  if p_delay_seconds not between 0 and 3600 or p_lease_seconds not between 60 and 3600
     or p_error_code is distinct from 'document_extraction_busy' then
    raise exception 'invalid_upload_defer';
  end if;
  select * into j from public.upload_processing_jobs where id=p_job_id for update;
  if not found or j.status <> 'running' or j.locked_by <> p_worker_id
    or j.attempts <> p_attempt or j.claim_token <> p_token
    or j.locked_at <= now()-make_interval(secs=>p_lease_seconds) then return false; end if;
  select * into f from public.upload_session_files where id=j.file_id and session_id=j.session_id for update;
  select * into s from public.upload_sessions where id=j.session_id for update;
  if f.id is null or s.id is null or s.user_id <> j.user_id or f.status <> 'processing'
     or s.status in ('cancelled','expired','error','completed') then return false; end if;
  -- The claim charged an attempt; a busy parser says nothing about the file.
  update public.upload_processing_jobs set status='queued', attempts=greatest(0, j.attempts-1),
    available_at=now()+make_interval(secs=>p_delay_seconds), locked_at=null, locked_by=null,
    claim_token=null, error_code=p_error_code, updated_at=now() where id=j.id;
  update public.upload_session_files set status='uploaded', error_code=null, updated_at=now() where id=f.id;
  perform public.refresh_upload_session_status(s.id);
  return true;
end; $$;
revoke all on function public.defer_upload_processing_job(uuid, text, integer, uuid, integer, text, integer)
  from public, web_anon, authenticated;
alter function public.defer_upload_processing_job(uuid, text, integer, uuid, integer, text, integer)
  owner to tenant_definer;
grant execute on function public.defer_upload_processing_job(uuid, text, integer, uuid, integer, text, integer)
  to tenant_app, service_role;
notify pgrst, 'reload schema';
