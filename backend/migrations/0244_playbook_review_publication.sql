-- Migration date: 2026-11-07
-- Upstream: 20261107_01_playbook_review_publication.sql (sync-log: 996afb6b,
-- "fix: publish playbook edits and review results atomically", PR #862).
-- Publish a review outcome and its document effects in one transaction: the
-- new version, its document_edits, activation, and run completion commit
-- together or not at all.
-- Dev divergence:
--  * Actor ids are text in Dev (playbook_runs.user_id, db_jobs payload
--    userId), so p_user_id is text. Anon is Dev's web_anon.
--  * Inline mode (p_job_identity null, the chat tool's in-process review) is
--    upstream's body on Dev's 6-argument create_document_version.
--  * Job mode (a worker-claimed playbook.review job) composes Dev's existing
--    fenced pieces in this one transaction instead of bypassing them: the
--    db_jobs claim fence, mutate_playbook_job 'document_check' (0164: role
--    tables share-locked, document locked, access, team placement and pinned
--    version checked), the job-fenced create_document_version (0165), and
--    mutate_playbook_job 'review_publish' (0164: access revalidated under the
--    same locks, run completed, SQL audit row, lease re-checked). A refusal
--    at review_publish rolls the version back (sub-block savepoint) and is
--    returned as its disposition. A text-only job review keeps Dev's
--    review_publish semantics (a changed document is 'conflict', not a
--    text-only completion).
--  * Multi-tenant (0180): owned by tenant_definer and executable by
--    tenant_app and service_role, like the functions it composes.
create or replace function public.publish_playbook_review(
  p_run_id uuid,
  p_user_id text,
  p_summary text,
  p_findings jsonb,
  p_document_id uuid default null,
  p_expected_version_id uuid default null,
  p_expected_storage_path text default null,
  p_version jsonb default null,
  p_edits jsonb default '[]'::jsonb,
  p_job_identity jsonb default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_run public.playbook_runs%rowtype;
  v_job public.db_jobs%rowtype;
  v_guard jsonb;
  v_refusal text;
  v_current uuid;
  v_document_exists boolean := false;
  v_source_exists boolean := false;
  v_source_path text;
  v_source_document_id uuid;
  v_source_deleted timestamptz;
  v_version jsonb;
  v_version_id uuid;
  v_findings jsonb := p_findings;
  v_item jsonb;
  v_row jsonb;
  v_edit_id uuid;
  v_index integer;
  v_annotation jsonb;
  v_native boolean := p_version is not null;
  v_disposition text := 'published';
  v_completed_at timestamptz := clock_timestamp();
begin
  if p_summary is null or p_findings is null or jsonb_typeof(p_findings) <> 'array'
     or jsonb_array_length(p_findings) > 1000
     or p_edits is null or jsonb_typeof(p_edits) <> 'array'
     or jsonb_array_length(p_edits) > 1000 then
    raise exception 'invalid_review_publication' using errcode = '22023';
  end if;
  if exists(
    select 1 from jsonb_array_elements(p_findings) as f(value)
    where jsonb_typeof(f.value) is distinct from 'object' or f.value ? 'edit'
  ) then
    raise exception 'findings_must_be_unlinked_objects' using errcode = '22023';
  end if;
  if v_native then
    if p_document_id is null or p_expected_version_id is null
       or p_expected_storage_path is null or jsonb_typeof(p_version) <> 'object'
       or jsonb_array_length(p_edits) = 0 then
      raise exception 'invalid_review_document' using errcode = '22023';
    end if;
    v_version_id := (p_version->>'id')::uuid;
    if p_version ? 'version_number' then
      raise exception 'review_version_number_is_allocated' using errcode = '22023';
    end if;
    if v_version_id is null or nullif(p_version->>'storage_path', '') is null
       or nullif(p_version->>'filename', '') is null
       or p_version->>'file_type' is distinct from 'docx'
       or p_version->>'source' is distinct from 'assistant_edit' then
      raise exception 'invalid_review_version' using errcode = '22023';
    end if;
    if exists(
      select 1 from jsonb_array_elements(p_edits) as e(value)
      where jsonb_typeof(e.value->'finding_index') is distinct from 'number'
         or e.value->>'id' is null or e.value->>'change_id' is null
    ) or (
      select count(*) <> count(distinct e.value->>'finding_index')
        or count(*) <> count(distinct e.value->>'change_id')
        from jsonb_array_elements(p_edits) as e(value)
    ) then
      raise exception 'invalid_review_edit_links' using errcode = '22023';
    end if;
  elsif jsonb_array_length(p_edits) <> 0 then
    raise exception 'edits_require_version' using errcode = '22023';
  end if;

  if p_job_identity is not null then
    -- Dev's canonical queue always locks before its domain/document rows.
    select * into v_job from public.db_jobs where id = (p_job_identity->>'id')::uuid for update;
    if not found or v_job.kind <> 'playbook.review'
       or v_job.attempts is distinct from (p_job_identity->>'attempt')::integer
       or v_job.claim_token is distinct from (p_job_identity->>'token')::uuid
       or v_job.status <> 'running' or v_job.lease_expires_at is null
       or v_job.lease_expires_at <= clock_timestamp()
       or v_job.payload->>'runId' is distinct from p_run_id::text
       or v_job.payload->>'userId' is distinct from p_user_id then
      raise exception 'playbook_claim_lost' using errcode = '40001';
    end if;
    if v_native then
      v_guard := public.mutate_playbook_job(v_job.id, v_job.attempts, v_job.claim_token,
        'document_check', p_run_id);
      if v_guard->>'result' = 'stale' then
        raise exception 'playbook_claim_lost' using errcode = '40001';
      elsif v_guard->>'result' in ('forbidden', 'conflict') then
        return jsonb_build_object('disposition', v_guard->>'result');
      elsif v_guard->>'result' = 'settled' then
        v_native := false;
      elsif v_guard->>'result' is distinct from 'current' then
        raise exception 'review_publication_guard_lost' using errcode = 'P0002';
      end if;
    end if;
    select * into v_run from public.playbook_runs
      where id = p_run_id and user_id = p_user_id for update;
    if not found then
      return jsonb_build_object('disposition', 'missing');
    end if;
    if v_run.status = 'completed' then
      return jsonb_build_object('disposition', 'existing', 'run', to_jsonb(v_run));
    end if;
    if v_run.status <> 'running' then
      return jsonb_build_object('disposition', 'terminal', 'run', to_jsonb(v_run));
    end if;
    if v_native and v_run.document_id is distinct from p_document_id then
      raise exception 'review_document_mismatch' using errcode = '22023';
    end if;
    begin
      if v_native then
        if exists(select 1 from public.document_versions where id = v_version_id) then
          raise exception 'review_version_identity_conflict' using errcode = '23505';
        end if;
        -- 0165's fence re-checks the claim, document scope and pinned version,
        -- inserts the edit rows, records edited_version_id and activates.
        v_version := public.create_document_version(p_document_id, p_version, true, p_job_identity,
          jsonb_build_object('id', p_expected_version_id, 'storagePath', p_expected_storage_path),
          (select jsonb_agg(e.value || jsonb_build_object(
            'deleted_text', coalesce(e.value->>'deleted_text', ''),
            'inserted_text', coalesce(e.value->>'inserted_text', '')))
            from jsonb_array_elements(p_edits) as e(value)));
        for v_item in select value from jsonb_array_elements(p_edits) loop
          v_index := (v_item->>'finding_index')::integer;
          if v_index < 0 or v_index >= jsonb_array_length(v_findings) then
            raise exception 'invalid_review_finding_index' using errcode = '22023';
          end if;
          select value into v_row from jsonb_array_elements(v_version->'edit_rows')
            where value->>'change_id' = v_item->>'change_id';
          if v_row is null then
            raise exception 'invalid_review_edit_links' using errcode = '22023';
          end if;
          v_annotation := jsonb_strip_nulls(jsonb_build_object(
            'kind', 'edit', 'edit_id', v_row->>'id', 'document_id', p_document_id,
            'version_id', v_version_id, 'version_number', (v_version->>'version_number')::integer,
            'change_id', v_item->>'change_id', 'del_w_id', v_item->>'del_w_id',
            'ins_w_id', v_item->>'ins_w_id', 'deleted_text', coalesce(v_item->>'deleted_text', ''),
            'inserted_text', coalesce(v_item->>'inserted_text', ''),
            'context_before', coalesce(v_item->>'context_before', ''),
            'context_after', coalesce(v_item->>'context_after', ''),
            'reason', v_item->>'reason', 'status', 'pending'
          ));
          v_findings := jsonb_set(v_findings, array[v_index::text, 'edit'], v_annotation, true);
          v_row := null;
        end loop;
        v_version := v_version - 'edit_rows';
      else
        v_version_id := null;
      end if;
      v_guard := public.mutate_playbook_job(v_job.id, v_job.attempts, v_job.claim_token,
        'review_publish', p_run_id, jsonb_build_object(
          'summary', p_summary, 'findings_json', v_findings, 'edited_version_id', v_version_id));
      if v_guard->>'result' in ('forbidden', 'conflict') then
        v_refusal := v_guard->>'result';
        -- Roll back this block's version, edits and activation.
        raise exception 'review_publication_refused' using errcode = 'MK862';
      elsif v_guard->>'result' = 'stale' then
        raise exception 'playbook_claim_lost' using errcode = '40001';
      elsif v_guard->>'result' is distinct from 'published' then
        raise exception 'review_publication_guard_lost' using errcode = 'P0002';
      end if;
    exception when sqlstate 'MK862' then
      return jsonb_build_object('disposition', v_refusal);
    end;
    select * into v_run from public.playbook_runs where id = p_run_id;
    return jsonb_build_object('disposition', v_disposition, 'run', to_jsonb(v_run), 'version', v_version);
  end if;

  -- Inline mode: upstream's body. Parent first, consistent with the document
  -- lifecycle primitives; lock source bytes too, since updateDocumentVersion
  -- can replace that row's storage path without locking the parent pointer.
  if v_native then
    select current_version_id into v_current
      from public.documents where id = p_document_id for update;
    v_document_exists := found;
    select storage_path, deleted_at, document_id
      into v_source_path, v_source_deleted, v_source_document_id
      from public.document_versions
      where id = p_expected_version_id
      for share;
    v_source_exists := found;
  end if;

  select * into v_run from public.playbook_runs
    where id = p_run_id and user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('disposition', 'missing');
  end if;
  if v_run.status = 'completed' then
    -- Never reactivate a result version after a later edit or user action.
    return jsonb_build_object('disposition', 'existing', 'run', to_jsonb(v_run));
  end if;
  if v_run.status <> 'running' then
    return jsonb_build_object('disposition', 'terminal', 'run', to_jsonb(v_run));
  end if;

  if v_native then
    if v_source_exists and v_source_document_id <> p_document_id then
      raise exception 'review_source_document_mismatch' using errcode = '22023';
    end if;
    if v_run.document_id is not null and v_run.document_id <> p_document_id then
      raise exception 'review_document_mismatch' using errcode = '22023';
    end if;
    if v_run.document_id is null or not v_document_exists or not v_source_exists
       or v_source_deleted is not null or v_current is distinct from p_expected_version_id
       or v_source_path is distinct from p_expected_storage_path then
      -- Text-only result without changing any document: a semantic outcome,
      -- not a DB failure fallback.
      v_native := false;
      v_version_id := null;
      v_disposition := 'source_changed';
    end if;
  end if;

  if v_native then
    -- A previous successful publication would have completed the run. Never
    -- quietly adopt an unrelated version through the lifecycle RPC's
    -- idempotent retry while the run is still running.
    if exists(select 1 from public.document_versions where id = v_version_id) then
      raise exception 'review_version_identity_conflict' using errcode = '23505';
    end if;
    v_version := public.create_document_version(p_document_id, p_version, false);
    for v_item in select value from jsonb_array_elements(p_edits) loop
      v_index := (v_item->>'finding_index')::integer;
      if v_index < 0 or v_index >= jsonb_array_length(v_findings) then
        raise exception 'invalid_review_finding_index' using errcode = '22023';
      end if;
      v_edit_id := (v_item->>'id')::uuid;
      insert into public.document_edits(
        id, document_id, version_id, change_id, del_w_id, ins_w_id,
        deleted_text, inserted_text, context_before, context_after, status
      ) values (
        v_edit_id, p_document_id, v_version_id,
        v_item->>'change_id', v_item->>'del_w_id', v_item->>'ins_w_id',
        coalesce(v_item->>'deleted_text', ''), coalesce(v_item->>'inserted_text', ''),
        coalesce(v_item->>'context_before', ''), coalesce(v_item->>'context_after', ''), 'pending'
      );
      v_annotation := jsonb_strip_nulls(jsonb_build_object(
        'kind', 'edit', 'edit_id', v_edit_id, 'document_id', p_document_id,
        'version_id', v_version_id, 'version_number', (v_version->>'version_number')::integer,
        'change_id', v_item->>'change_id', 'del_w_id', v_item->>'del_w_id',
        'ins_w_id', v_item->>'ins_w_id', 'deleted_text', coalesce(v_item->>'deleted_text', ''),
        'inserted_text', coalesce(v_item->>'inserted_text', ''),
        'context_before', coalesce(v_item->>'context_before', ''),
        'context_after', coalesce(v_item->>'context_after', ''),
        'reason', v_item->>'reason', 'status', 'pending'
      ));
      v_findings := jsonb_set(v_findings, array[v_index::text, 'edit'], v_annotation, true);
    end loop;
    if not public.activate_document_version(p_document_id, v_version_id) then
      raise exception 'review_activation_failed' using errcode = 'P0002';
    end if;
  end if;

  update public.playbook_runs set
    status = 'completed', summary = p_summary, findings_json = v_findings,
    edited_version_id = v_version_id, error = null,
    completed_at = v_completed_at, updated_at = v_completed_at
    where id = p_run_id and user_id = p_user_id and status = 'running'
    returning * into v_run;
  if not found then
    raise exception 'review_publication_guard_lost' using errcode = 'P0002';
  end if;
  return jsonb_build_object('disposition', v_disposition, 'run', to_jsonb(v_run), 'version', v_version);
end;
$$;
revoke all on function public.publish_playbook_review(uuid, text, text, jsonb, uuid, uuid, text, jsonb, jsonb, jsonb)
  from public, web_anon, authenticated;
alter function public.publish_playbook_review(uuid, text, text, jsonb, uuid, uuid, text, jsonb, jsonb, jsonb)
  owner to tenant_definer;
grant execute on function public.publish_playbook_review(uuid, text, text, jsonb, uuid, uuid, text, jsonb, jsonb, jsonb)
  to tenant_app, service_role;
notify pgrst, 'reload schema';
