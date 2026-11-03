-- Multi-tenant follow-up to the merge into main (docs/issues/multi-tenant/
-- HANDOFF.md, "Open follow-ups": platform writes that reach tenant_definer
-- code). The upload worker claims and expires upload processing jobs with
-- the platform client (service_role, no tenant claim): main's
-- claim_upload_processing_job (0076) and expire_exhausted_upload_jobs (0078)
-- are platform functions owned by service_role, but both call
-- refresh_upload_session_status, a tenant function that 0178 re-owned to
-- tenant_definer. Under forced RLS (0180) that function saw no session with
-- a NULL claim and raised upload_session_not_found, which aborted the whole
-- platform statement: no upload job could be claimed and exhausted jobs were
-- never expired, on single and pooled installs alike.
--
-- Fix, the 0180 document_text_job_failed pattern: the session refresh runs
-- as the session's own tenant. app.refresh_upload_session_as_tenant sets the
-- tenant claim to the session's tenant_id transaction-locally, calls the
-- canonical refresh and restores the caller's claims. It is an invoker
-- function executable only by service_role; called from the two
-- service_role-owned functions it reads the session's tenant with RLS
-- bypassed. Only the platform can call those functions, so the claim switch
-- gives no tenant anything new.
--
-- Both functions also skip jobs of an offboarding tenant: 0194's offboarding
-- fence raises 42501 on their job/file/session writes, which would fail every
-- worker's claim (and every expiry sweep) for every tenant until the purge
-- deletes the jobs. A tenant that starts offboarding between the check and
-- the write fails one poll only; the next one skips it.
--
-- Main's bodies are otherwise unchanged: they are rewritten from the live
-- definitions, and each edit must match exactly once.
--
-- The audit that found this also covered every trigger function 0178
-- re-owned to tenant_definer (docs/issues/multi-tenant/008-forced-rls.md,
-- "Tenant-definer audit"): no writer without a tenant claim fires them today.

create or replace function app.refresh_upload_session_as_tenant(p_session_id uuid)
returns text
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_tenant text;
  v_claims text := current_setting('request.jwt.claims', true);
  v_status text;
begin
  select s.tenant_id into v_tenant from public.upload_sessions s where s.id = p_session_id;
  if v_tenant is null then
    -- No tenant to act as: the canonical function decides (not found).
    return public.refresh_upload_session_status(p_session_id);
  end if;
  perform set_config('request.jwt.claims',
    (coalesce(nullif(v_claims, ''), '{}')::jsonb || jsonb_build_object('tenant_id', v_tenant))::text, true);
  v_status := public.refresh_upload_session_status(p_session_id);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return v_status;
end;
$$;
revoke all on function app.refresh_upload_session_as_tenant(uuid) from public, web_anon, authenticated;
grant execute on function app.refresh_upload_session_as_tenant(uuid) to service_role;

do $$
declare
  v_edit record;
  v_definition text;
  v_count integer;
begin
  for v_edit in
    select * from (values
      ('public.claim_upload_processing_job(text,integer,integer)',
       'perform public.refresh_upload_session_status(claimed_session_id);',
       'perform app.refresh_upload_session_as_tenant(claimed_session_id);'),
      ('public.claim_upload_processing_job(text,integer,integer)',
       E'    where attempts < 3\n',
       E'    where attempts < 3\n      and not exists (select 1 from public.tenants t\n        where t.tenant_id = upload_processing_jobs.tenant_id and t.status = ''offboarding'')\n'),
      ('public.expire_exhausted_upload_jobs(integer,integer)',
       'perform public.refresh_upload_session_status(j.session_id);',
       'perform app.refresh_upload_session_as_tenant(j.session_id);'),
      ('public.expire_exhausted_upload_jobs(integer,integer)',
       'where status=''running'' and attempts>=3',
       E'where status=''running'' and attempts>=3\n      and not exists (select 1 from public.tenants t\n        where t.tenant_id = upload_processing_jobs.tenant_id and t.status = ''offboarding'')')
    ) as e(sig, old_text, new_text)
  loop
    v_definition := pg_get_functiondef(v_edit.sig::regprocedure);
    v_count := (length(v_definition) - length(replace(v_definition, v_edit.old_text, ''))) / length(v_edit.old_text);
    if v_count <> 1 then
      raise exception 'multi-tenant: expected one match in %, found %', v_edit.sig, v_count;
    end if;
    execute replace(v_definition, v_edit.old_text, v_edit.new_text);
  end loop;

  -- create or replace keeps the platform owner; the RLS bypass relies on it.
  if exists (
    select 1 from pg_proc p join pg_roles o on o.oid = p.proowner
     where p.oid in ('public.claim_upload_processing_job(text,integer,integer)'::regprocedure,
                     'public.expire_exhausted_upload_jobs(integer,integer)'::regprocedure)
       and o.rolname <> 'service_role'
  ) then
    raise exception 'multi-tenant: upload claim functions must stay owned by service_role';
  end if;
  if exists (
    select 1 from pg_proc p
     where p.oid in ('public.claim_upload_processing_job(text,integer,integer)'::regprocedure,
                     'public.expire_exhausted_upload_jobs(integer,integer)'::regprocedure)
       and p.prosrc ~ 'public\.refresh_upload_session_status\('
  ) then
    raise exception 'multi-tenant: upload claim functions still refresh sessions without a tenant claim';
  end if;
end $$;

do $$
declare
  v_gaps text;
begin
  select string_agg(object || ': ' || problem, '; ') into v_gaps from app.tenant_rls_gaps();
  if v_gaps is not null then
    raise exception 'multi-tenant: tenant RLS gaps: %', v_gaps;
  end if;
  select string_agg(object || ': ' || problem, '; ') into v_gaps from app.control_plane_gaps();
  if v_gaps is not null then
    raise exception 'multi-tenant: control-plane gaps: %', v_gaps;
  end if;
end $$;

notify pgrst, 'reload schema';
